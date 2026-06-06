import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/future-me
// 環境変数: GEMINI_API_KEY
// 使用モデル: gemini-2.5-flash-lite → gemini-2.5-flash の順に試行
// ============================================================

// ── モデル試行リスト（上から順に試す）────────────────────────
const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',   // 最軽量・最速（優先）
  'gemini-2.5-flash',        // フラッシュ標準（次点）
];

// ── サーバーサイドフォールバック ──────────────────────────────
// Gemini APIが失敗した場合に、記録内容（メモ・URL）から
// 具体的な問いかけを生成する。汎用文は禁止。
function buildLocalComment(currentEntry) {
  const memo = (currentEntry.memo || '').trim();
  const url  = (currentEntry.url  || '').trim();
  const date = (currentEntry.date || '');
  // 大文字小文字を無視した検索用テキスト
  const text = (memo + ' ' + url).toLowerCase();

  // ── URLからサービス名を抽出 ──────────────────────────
  let urlHint = '';
  if (url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      const service  = hostname.split('.')[0].toLowerCase();
      const svcMap = {
        makuake:   'Makuake',
        campfire:  'CAMPFIRE',
        youtube:   'YouTube',
        twitter:   'X(Twitter)',
        instagram: 'Instagram',
        note:      'note',
        facebook:  'Facebook',
        amazon:    'Amazon',
        base:      'BASE',
        stores:    'STORES',
        spotify:   'Spotify',
        netflix:   'Netflix',
        tiktok:    'TikTok',
      };
      urlHint = svcMap[service] || hostname;
    } catch { /* URL解析失敗は無視 */ }
  }

  // メモを短縮（20字以内）
  const short = memo.length > 20 ? memo.slice(0, 20) + '…' : memo;

  // ════════════════════════════════════════════
  // 優先度順にキーワードで分岐（12パターン）
  // ════════════════════════════════════════════

  // ① クラウドファンディング・挑戦
  if (/makuake|campfire|クラファン|クラウドファンディング|挑戦中|挑戦し/.test(text)
      || urlHint === 'Makuake' || urlHint === 'CAMPFIRE') {
    const svc = (urlHint === 'Makuake' || urlHint === 'CAMPFIRE') ? urlHint : 'Makuake';
    return `${svc}に挑戦していましたね。今も新しい展開を考えていますか？`;
  }

  // ② 年数・継続（「5年」「3年」など）
  const yearMatch = memo.match(/(\d+)\s*年/);
  if (yearMatch) {
    const yr = yearMatch[1];
    return urlHint
      ? `${urlHint}、${yr}年続いているんですね。今も育てたいテーマですか？`
      : `「${short}」${yr}年経った今も続いていますか？`;
  }

  // ③ 音楽 ─ アーティスト名があれば使う
  const artistMatch = memo.match(
    /(くるり|シティポップ|jazz|ジャズ|フィッシュマンズ|椎名林檎|サカナクション|きのこ帝国|ヨルシカ|YOASOBI|米津|ビートルズ|Beatles)/i
  );
  if (artistMatch) {
    return `「${artistMatch[1]}」、今も聴いていますか？最近のお気に入りは変わりましたか？`;
  }
  if (/音楽|プレイリスト|ライブ|コンサート|アルバム|推し|バンド|ミュージック|歌|曲/.test(text)
      || urlHint === 'Spotify') {
    return 'この曲、今も聴いていますか？最近のお気に入りは変わりましたか？';
  }

  // ④ アニメ・マンガ ─ タイトル名があれば使う
  const animeMatch = memo.match(
    /(チェーンソーマン|チェインソーマン|鬼滅|進撃の巨人|ワンピース|呪術廻戦|ドラゴンボール|ナルト|ハンターハンター|ブルーロック|推しの子|葬送のフリーレン|スパイファミリー)/
  );
  if (animeMatch && /アニメ|マンガ|漫画|コミック/.test(text)) {
    return `「${animeMatch[1]}」、今も印象に残っている場面はありますか？`;
  }
  if (/アニメ|マンガ|漫画|コミック/.test(text)) {
    return memo ? `「${short}」今も好きですか？印象に残っている場面はありますか？` : 'この作品、今も好きですか？';
  }

  // ⑤ 映画・ドラマ・YouTube動画
  if (/映画|ドラマ|cinema|film/.test(text)) {
    return memo ? `「${short}」今も印象に残っていますか？` : 'この映画、もう一度見たいと思いますか？';
  }
  if (urlHint === 'YouTube' || /youtube|動画/.test(text)) {
    return 'この動画、今も参考にしていますか？';
  }

  // ⑥ テクノロジー・AI・Web3系
  if (/\bai\b|機械学習|web3|ブロックチェーン|nft|メタバース|プログラミング|コード|エンジニア|アプリ開発|deploy/.test(text)) {
    return memo ? `「${short}」最近また取り組んでいますか？` : 'このテーマ、最近また触れましたか？';
  }

  // ⑦ 伝統・文化・ファッション・プロダクト
  if (/伝統|布|織|染|和柄|着物|ファッション|服|ブランド|デザイン|アクセ|雑貨/.test(text)) {
    return memo ? `「${short}」今も伝えたいテーマとして続いていますか？` : '今もこのテーマを大切にしていますか？';
  }

  // ⑧ ビジネス・販売
  if (/販売|売上|ショップ|出品|商品|リリース|サービス|launch|起業|会社/.test(text)) {
    return memo ? `「${short}」その後、どんな変化がありましたか？` : `${urlHint ? urlHint + 'の' : ''}活動、今も続いていますか？`;
  }

  // ⑨ 学習・研究
  if (/勉強|学習|講義|セミナー|資格|試験|研究|勉強中|学ん/.test(text)) {
    return memo ? `「${short}」今も学び続けていますか？` : 'この学び、今も活きていますか？';
  }

  // ⑩ 旅行・おでかけ
  if (/旅行|旅|観光|海外|温泉|ホテル|景色|trip|travel|訪れ/.test(text)) {
    return memo ? `「${short}」また行きたいと思いますか？` : 'この場所、また訪れたいですか？';
  }

  // ⑪ 人との出会い・社交（複合語のみ。「会」単独は除外）
  if (/友達|友人|知り合い|仲間|出会い|カフェで|展示会|イベントで|飲み会|ランチ|集まり|パーティ|ミートアップ/.test(text)) {
    return 'この時に会った人と、最近もつながっていますか？';
  }

  // ⑫ アイデア・企画
  if (/アイデア|構想|企画|プラン|やりたい|したい|考えて/.test(text)) {
    return memo ? `「${short}」そのアイデア、今も温めていますか？` : 'このアイデア、今も続いていますか？';
  }

  // ── メモがある場合：内容を引用して問いかけ ──────────────────
  if (memo) {
    return `「${short}」今も気になっていますか？`;
  }

  // ── URLのみ ─────────────────────────────────────────────
  if (urlHint) {
    return `${urlHint}に保存していましたね。今も参考にしていますか？`;
  }
  if (url) {
    return 'このURL、今見ても気になりますか？';
  }

  // ── 写真のみ・何もない：日付から季節コメント ─────────────────
  const month = parseInt(date.slice(5, 7), 10);
  if (month >= 3  && month <= 5)  return 'この春の記録、今見ると何を思い出しますか？';
  if (month >= 6  && month <= 8)  return 'この夏の記録、当時何を考えていましたか？';
  if (month >= 9  && month <= 11) return 'この秋の記録、あの頃と今で変わりましたか？';
  return 'この記録、今も気になっていますか？';
}

// ── Geminiへのコンテンツ生成（モデルを順番に試す）─────────────
async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      console.log(`[future-me] trying model: ${model}`);
      const response = await ai.models.generateContent({
        model,
        ...generateConfig,
      });
      console.log(`[future-me] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[future-me] model "${model}" failed:`, errMsg);
      lastErr = err;
      if (isNotFound) {
        // モデルが存在しない場合は次を試す
        continue;
      }
      // 429 / 500 等モデル以外のエラーは即throw（フォールバックへ）
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
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

  const { currentEntry, recentEntries = [], memoryThemes = [] } = req.body || {};

  if (!currentEntry) {
    return res.status(400).json({ error: 'currentEntry is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[future-me] GEMINI_API_KEY is not set → local fallback');
    return res.status(200).json({ comment: buildLocalComment(currentEntry) });
  }

  // ── プロンプト構築 ────────────────────────────────────
  const currentText = [
    '現在の記録：',
    `日付: ${currentEntry.date || 'なし'}`,
    `メモ: ${currentEntry.memo || 'なし'}`,
    `URL: ${currentEntry.url  || 'なし'}`,
  ].join('\n');

  const safeRecent = Array.isArray(recentEntries) ? recentEntries.slice(0, 10) : [];
  const recentText = safeRecent.length > 0
    ? '\n\n最近の記録（直近10件）：\n' +
      safeRecent.map((e, i) =>
        `${i + 1}. ${e.date || '?'} / ${e.memo || 'なし'} / ${e.url || 'URLなし'}`
      ).join('\n')
    : '';

  const safeMemory = Array.isArray(memoryThemes) ? memoryThemes.slice(0, 20) : [];
  const memoryText = safeMemory.length > 0
    ? '\n\n人生テーマメモリー（以前から続いているテーマ）：\n' +
      safeMemory.map(t => `・${t.theme}（重要度: ${t.strength || 1}）`).join('\n')
    : '';

  const userPrompt = currentText + recentText + memoryText;

  const systemInstruction = `あなたは「Future Me（未来の自分）」です。
ユーザーの記録と、これまでの人生テーマメモリーをもとに、長年の知人として自然に話しかけます。

条件（厳守）：
- 日本語・80文字以内
- 質問は1つまで（複数の質問を入れない）
- 「以前から続いているテーマ」とのつながりに必ず言及する（テーマメモリーがある場合）
- テーマメモリーがない場合は現在の記録内容（メモやURL）に言及する
- 説教禁止・ポエム禁止・診断禁止・アドバイス禁止
- 介護っぽい言い方・心配ベースの言い方をしない
- 「〜ですね」「〜ましたね」などの自然な確認口調で話す
- 汎用的な返答禁止（必ず記録内容かテーマに言及）

例：「ミャンマーパンツや布の活動、ずっと続いていますね。今回は何を伝えたいですか？」`;

  // ── Gemini API 呼び出し ───────────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[future-me] prompt:', userPrompt);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { comment: { type: 'string' } },
          required: ['comment'],
        },
        maxOutputTokens: 150,
        temperature: 0.8,
      },
    });

    console.log(`[future-me] response.text (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();

    // response.text が空なら candidates から直接取得
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
          console.log('[future-me] candidates fallback raw:', effectiveRaw);
        }
      } catch (e) {
        console.warn('[future-me] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) {
      console.error('[future-me] empty response. Full:', JSON.stringify(response, null, 2));
      throw new Error('Empty response from Gemini');
    }

    // JSON から comment を抽出
    let comment = null;
    try {
      comment = JSON.parse(effectiveRaw).comment;
    } catch {
      const match = effectiveRaw.match(/"comment"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (match) comment = match[1];
      else console.warn('[future-me] JSON parse failed. raw:', effectiveRaw);
    }

    if (!comment || comment.trim() === '') {
      console.error('[future-me] comment is empty. raw was:', effectiveRaw);
      throw new Error('Empty comment from Gemini');
    }

    // ✅ 成功ログ
    console.log('[future-me] Gemini success:', comment.trim());
    return res.status(200).json({ comment: comment.trim() });

  } catch (err) {
    // 429 / 500 / タイムアウト / モデル全滅 → ローカルフォールバック
    const isQuota = /429|RESOURCE_EXHAUSTED|quota/i.test(err.message || '');
    console.warn(
      isQuota
        ? '[future-me] 429 quota → local fallback'
        : '[future-me] API error → local fallback:',
      err.message || err
    );

    const fallbackComment = buildLocalComment(currentEntry);
    console.log('[future-me] local fallback comment:', fallbackComment);
    return res.status(200).json({ comment: fallbackComment });
  }
}
