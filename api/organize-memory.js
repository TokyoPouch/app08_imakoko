import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/organize-memory
// 環境変数: GEMINI_API_KEY
// 役割: 直近10件の記録 + 現在のテーマメモリーをGeminiに渡し
//       統合・整理されたテーマリストを返す
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
      console.log(`[organize-memory] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[organize-memory] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[organize-memory] model "${model}" failed:`, errMsg);
      lastErr = err;
      if (isNotFound) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
}

// ── ローカルフォールバック（Gemini不使用時） ───────────────────
// 記録のメモからシンプルにキーワード抽出してテーマを生成する
function buildLocalThemes(currentMemory, recentEntries) {
  const existing = Array.isArray(currentMemory) ? currentMemory : [];

  // 既存テーマをそのまま返す（最大20件）
  // （API失敗時は現状維持）
  return existing.slice(0, 20);
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

  const { currentMemory = [], recentEntries = [] } = req.body || {};

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[organize-memory] GEMINI_API_KEY is not set → local fallback');
    const themes = buildLocalThemes(currentMemory, recentEntries);
    return res.status(200).json({ themes });
  }

  // ── プロンプト構築 ──────────────────────────────────────────
  const existingThemesText = currentMemory.length > 0
    ? '現在のテーマメモリー：\n' +
      currentMemory.map((t, i) =>
        `${i + 1}. ${t.theme}（重要度: ${t.strength || 1}）`
      ).join('\n')
    : '現在のテーマメモリー：なし';

  const safeRecent = Array.isArray(recentEntries) ? recentEntries.slice(0, 10) : [];
  const recentText = safeRecent.length > 0
    ? '\n\n直近の記録（最大10件）：\n' +
      safeRecent.map((e, i) =>
        `${i + 1}. ${e.date || '?'} ／ ${e.memo || 'なし'} ／ ${e.url || 'URLなし'}`
      ).join('\n')
    : '\n\n直近の記録：なし';

  const userPrompt = existingThemesText + recentText;

  const systemInstruction = `あなたはユーザーの「人生テーマ記憶係」です。
ユーザーの記録から、継続して関心を持っているテーマを抽出・整理してください。

ルール：
- 既存テーマと完全一致するものは追加しない
- 類似テーマ（例：「ミャンマーパンツ」と「服と布文化」）は統合して1つにまとめる
- 記録から新しいテーマが見つかれば追加する
- 最大20件まで保持（重要度が低いものを削除）
- strengthは1〜5で、よく登場するテーマほど高くする
- relatedEntryIds は記録から特定できるIDを含める（不明な場合は空配列）
- テーマ名は短く・具体的に（例：「ミャンマーパンツ」「認知症支援」「AIと人の関係」）
- 抽象的すぎる名前（「生活」「趣味」など）は避ける
- 必ずJSON形式で返す`;

  // ── Gemini API 呼び出し ─────────────────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[organize-memory] prompt length:', userPrompt.length);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            themes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  theme:          { type: 'string' },
                  strength:       { type: 'number' },
                  relatedEntryIds: {
                    type: 'array',
                    items: { type: 'number' }
                  }
                },
                required: ['theme', 'strength', 'relatedEntryIds']
              }
            }
          },
          required: ['themes']
        },
        maxOutputTokens: 1000,
        temperature: 0.4,
      },
    });

    console.log(`[organize-memory] response.text (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();

    // response.text が空なら candidates から直接取得
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
        }
      } catch (e) {
        console.warn('[organize-memory] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) {
      throw new Error('Empty response from Gemini');
    }

    let parsed;
    try {
      parsed = JSON.parse(effectiveRaw);
    } catch {
      throw new Error('JSON parse failed: ' + effectiveRaw.slice(0, 100));
    }

    const themes = Array.isArray(parsed.themes) ? parsed.themes.slice(0, 20) : [];

    console.log('[organize-memory] Gemini success, themes count:', themes.length);
    return res.status(200).json({ themes });

  } catch (err) {
    console.warn('[organize-memory] API error → local fallback:', err.message || err);
    const themes = buildLocalThemes(currentMemory, recentEntries);
    return res.status(200).json({ themes });
  }
}
