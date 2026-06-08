import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/reorganize-shelf
// 環境変数: GEMINI_API_KEY
// 役割: 棚/本データ + 記録（メモ・URL・futureMeコメント）を Gemini に渡し、
//       意味的な関連付けを行って relations を返す
// v3.31: 画像Base64は使用しない
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// ── モデル試行ヘルパー ─────────────────────────────────────────
async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      console.log(`[reorganize-shelf] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[reorganize-shelf] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[reorganize-shelf] model "${model}" failed:`, errMsg);
      lastErr = err;
      if (isNotFound) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
}

// ── ローカルフォールバック（キーワードマッチ）────────────────────
/**
 * Gemini API が使えない場合のフォールバック。
 * book.keywords または book.title との部分一致で relations を構築する。
 *
 * @param {Array} shelfData  - 棚/本データ
 * @param {Array} entries    - 記録データ（画像なし）
 * @returns {Object} relations
 */
function buildLocalRelations(shelfData, entries) {
  const relations = {};
  for (const shelfItem of (shelfData || [])) {
    for (const book of (shelfItem.books || [])) {
      const keywords = Array.isArray(book.keywords) ? book.keywords : [];
      const matched = (entries || []).filter(entry => {
        const text = ((entry.memo || '') + ' ' + (entry.url || '') + ' ' + (entry.futureMe || '')).toLowerCase();
        if (keywords.some(kw => kw && text.includes(kw.toLowerCase()))) return true;
        if (book.title && text.includes(book.title.toLowerCase())) return true;
        return false;
      });
      if (matched.length > 0) {
        relations[book.title] = matched.map(e => String(e.id));
      }
    }
  }
  return relations;
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { shelfData = [], entries = [] } = req.body || {};

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[reorganize-shelf] GEMINI_API_KEY is not set → local fallback');
    const relations = buildLocalRelations(shelfData, entries);
    return res.status(200).json({ relations });
  }

  // ── 棚/本のリストを整形（プロンプト用） ─────────────────────
  const shelfSummary = (shelfData || []).flatMap(s =>
    (s.books || []).map(b => b.title)
  );

  // ── Geminiプロンプト ─────────────────────────────────────────
  const userPrompt = `以下のJSONのみを返してください。
マークダウン（\`\`\`json 等の囲み）・前置き・説明文は一切禁止。

あなたは記録と関心テーマの関連を判定するAIです。
各記録を読み、どの「本」に関連するか意味的に判断してください。
直接の言及がなくても、文脈・活動内容から判断してください。
返却する本の名前は、必ず入力された「棚と本」にある名前と完全一致させてください。
入力された本に存在しない名前を新しく作らないでください。

【関連付けの考え方】

例：

記録：
福岡県ではんてん作りを見学

関連先：
日本の伝統布
ミャンマーパンツ

理由：
はんてん・織物・布文化は、ユーザーの日本の伝統布やミャンマーパンツの活動と関連するため。

---

【出力フォーマット】

{
  "relations": {
    "日本の伝統布": ["entry001", "entry008"],
    "ミャンマーパンツ": ["entry001"],
    "AIとの対話": ["entry003"]
  }
}

※ 関連する記録がない本はキーを含めないでください。
※ entryのIDは入力データの id フィールドをそのまま使用してください。

---

【入力データ】

棚と本:
${JSON.stringify(shelfSummary)}

記録:
${JSON.stringify(entries.slice(0, 50))}`;

  // ── Gemini API 呼び出し ─────────────────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[reorganize-shelf] prompt length:', userPrompt.length);
    console.log('[reorganize-shelf] entries count:', entries.length);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            relations: {
              type: 'object',
              // 各プロパティ（本のタイトル）→ 文字列配列（記録ID）
              additionalProperties: {
                type: 'array',
                items: { type: 'string' }
              }
            }
          },
          required: ['relations']
        },
        maxOutputTokens: 2000,
        temperature: 0.3, // 一貫性を高めるため低めに設定
      },
    });

    console.log(`[reorganize-shelf] response.text (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();

    // response.text が空なら candidates から直接取得
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
        }
      } catch (e) {
        console.warn('[reorganize-shelf] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) throw new Error('Empty response from Gemini');

    // マークダウンコードブロックが含まれる場合は除去
    effectiveRaw = effectiveRaw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(effectiveRaw);
    } catch {
      throw new Error('JSON parse failed: ' + effectiveRaw.slice(0, 200));
    }

    // relations を検証・サニタイズ
    // - キー（本のタイトル）が shelfSummary に存在するものだけを残す
    // - 値は文字列配列であることを保証
    const safeRelations = {};
    const bookTitleSet = new Set(shelfSummary);

    if (parsed.relations && typeof parsed.relations === 'object') {
      for (const [bookTitle, ids] of Object.entries(parsed.relations)) {
        // 存在しない本名は無視（プロンプト違反の防止）
        if (!bookTitleSet.has(bookTitle)) {
          console.warn(`[reorganize-shelf] 未知の本タイトルをスキップ: "${bookTitle}"`);
          continue;
        }
        if (!Array.isArray(ids)) continue;
        const validIds = ids.filter(id => typeof id === 'string' && id.trim());
        if (validIds.length > 0) {
          safeRelations[bookTitle] = validIds;
        }
      }
    }

    console.log('[reorganize-shelf] Gemini success, books matched:', Object.keys(safeRelations).length);
    return res.status(200).json({ relations: safeRelations });

  } catch (err) {
    console.warn('[reorganize-shelf] API error → local fallback:', err.message || err);
    const relations = buildLocalRelations(shelfData, entries);
    return res.status(200).json({ relations });
  }
}
