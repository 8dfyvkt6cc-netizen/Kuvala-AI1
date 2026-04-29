import {
  Bot,
  GrammyError,
  HttpError,
  InlineKeyboard,
  InputFile,
  Keyboard,
  session,
  type Context,
  type SessionFlavor,
} from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { pool } from "@workspace/db";
import { logger } from "./lib/logger";

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"] ?? "";

const OWNER_USERNAME = (process.env["TELEGRAM_OWNER_USERNAME"] ?? "")
  .replace(/^@/, "")
  .trim();
const OWNER_CONTACT = OWNER_USERNAME ? `@${OWNER_USERNAME}` : "";

const BRAND = process.env["BRAND_NAME"] ?? "Kuvala";
const BRAND_TAGLINE_RU =
  process.env["BRAND_TAGLINE_RU"] ??
  "Премиум-помощник для создателей контента. Заменяет команду из копирайтера, дизайнера и аналитика — работает 24/7 под вашу нишу.";
const BRAND_TAGLINE_EN =
  process.env["BRAND_TAGLINE_EN"] ??
  "Premium helper for content creators. Replaces a team of copywriter, designer and analyst — works 24/7 for your niche.";

const FREE_QUOTA = Number(process.env["FREE_QUOTA"] ?? "10");

const RATE_FREE_PER_MIN = Number(process.env["RATE_FREE_PER_MIN"] ?? "5");
const RATE_PREMIUM_PER_MIN = Number(process.env["RATE_PREMIUM_PER_MIN"] ?? "30");

const TEXT_MODEL = process.env["BOT_TEXT_MODEL"] ?? "claude-sonnet-4-6";
const IMAGE_MODEL = process.env["BOT_IMAGE_MODEL"] ?? "gemini-3-pro-image-preview";

const PRICE_INPUT_PER_1K = Number(process.env["PRICE_INPUT_PER_1K"] ?? "0.003");
const PRICE_OUTPUT_PER_1K = Number(process.env["PRICE_OUTPUT_PER_1K"] ?? "0.015");
const PRICE_IMAGE = Number(process.env["PRICE_IMAGE"] ?? "0.04");

const STAR_PLANS_RAW =
  process.env["STAR_PLANS"] ??
  "1 неделя:50:7,1 месяц:150:30,3 месяца:400:90";

interface StarPlan {
  label: string;
  stars: number;
  days: number;
}

const STAR_PLANS: StarPlan[] = STAR_PLANS_RAW.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => {
    const [label, stars, days] = p.split(":");
    return {
      label: (label ?? "Plan").trim(),
      stars: Math.max(1, Math.floor(Number(stars))),
      days: Math.max(1, Math.floor(Number(days))),
    };
  })
  .filter((p) => Number.isFinite(p.stars) && Number.isFinite(p.days));

const textEngine = new Anthropic({
  apiKey: process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"] ?? "",
  baseURL: process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"] ?? "",
});

const imageEngine = new GoogleGenAI({
  apiKey: process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] ?? "",
  httpOptions: {
    baseUrl: process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"] ?? "",
  },
});

type Mode =
  | null
  | "post_topic"
  | "post_followup"
  | "idea_niche"
  | "hook_topic"
  | "headline_topic"
  | "image_prompt"
  | "plan_niche"
  | "analyze_text"
  | "repurpose_text"
  | "hashtag_topic"
  | "rewrite_text"
  | "caption_photo"
  | "brand_niche"
  | "brand_audience"
  | "brand_tone"
  | "brand_language"
  | "schedule_channel"
  | "schedule_text"
  | "schedule_when";

interface BrandProfile {
  niche?: string;
  audience?: string;
  tone?: string;
  language?: string;
}

type Lang = "ru" | "en";

interface ScheduleDraft {
  channel?: string;
  text?: string;
}

interface SessionData {
  mode: Mode;
  brand: BrandProfile;
  lastPost?: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  lang: Lang;
  onboarded: boolean;
  schedule: ScheduleDraft;
}

type BotContext = Context & SessionFlavor<SessionData>;

interface UserStatus {
  isOwner: boolean;
  isPremium: boolean;
  used: number;
  remaining: number;
  subscriptionUntil: Date | null;
  plan: string | null;
}

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      generations_used INT NOT NULL DEFAULT 0,
      subscription_until TIMESTAMPTZ,
      plan TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS generations_used INT NOT NULL DEFAULT 0;
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS subscription_until TIMESTAMPTZ;
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS plan TEXT;
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS ui_lang TEXT;
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS captcha_passed BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS captcha_target TEXT;

    CREATE TABLE IF NOT EXISTS bot_brands (
      user_id BIGINT PRIMARY KEY REFERENCES bot_users(id) ON DELETE CASCADE,
      niche TEXT,
      audience TEXT,
      tone TEXT,
      language TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bot_generations (
      id SERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES bot_users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      input TEXT,
      output TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bot_generations_user_idx
      ON bot_generations(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bot_usage (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      kind TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INT NOT NULL DEFAULT 0,
      output_tokens INT NOT NULL DEFAULT 0,
      cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bot_usage_user_idx
      ON bot_usage(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bot_payments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      charge_id TEXT UNIQUE,
      stars INT NOT NULL,
      plan TEXT,
      days INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bot_scheduled_posts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      channel TEXT NOT NULL,
      text TEXT NOT NULL,
      scheduled_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bot_scheduled_posts_due_idx
      ON bot_scheduled_posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS bot_scheduled_posts_user_idx
      ON bot_scheduled_posts(user_id, created_at DESC);
  `);
}

async function upsertUser(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;
  await pool.query(
    `INSERT INTO bot_users (id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_seen = now()`,
    [ctx.from.id, ctx.from.username ?? null, ctx.from.first_name ?? null],
  );
}

async function loadBrand(userId: number): Promise<BrandProfile> {
  const r = await pool.query(
    `SELECT niche, audience, tone, language FROM bot_brands WHERE user_id = $1`,
    [userId],
  );
  if (r.rows.length === 0) return {};
  const row = r.rows[0];
  return {
    niche: row.niche ?? undefined,
    audience: row.audience ?? undefined,
    tone: row.tone ?? undefined,
    language: row.language ?? undefined,
  };
}

async function saveBrand(userId: number, brand: BrandProfile): Promise<void> {
  await pool.query(
    `INSERT INTO bot_brands (user_id, niche, audience, tone, language, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       niche = EXCLUDED.niche,
       audience = EXCLUDED.audience,
       tone = EXCLUDED.tone,
       language = EXCLUDED.language,
       updated_at = now()`,
    [
      userId,
      brand.niche ?? null,
      brand.audience ?? null,
      brand.tone ?? null,
      brand.language ?? null,
    ],
  );
}

async function logGeneration(
  userId: number | undefined,
  kind: string,
  input: string,
  output: string,
): Promise<void> {
  if (!userId) return;
  await pool.query(
    `INSERT INTO bot_generations (user_id, kind, input, output) VALUES ($1, $2, $3, $4)`,
    [userId, kind, input.slice(0, 4000), output.slice(0, 8000)],
  );
}

async function recentHistory(
  userId: number,
  limit = 10,
): Promise<Array<{ kind: string; input: string; created_at: Date }>> {
  const r = await pool.query(
    `SELECT kind, input, created_at FROM bot_generations
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}

async function getUserStatus(userId: number): Promise<UserStatus> {
  const r = await pool.query(
    `SELECT generations_used, subscription_until, plan, username
     FROM bot_users WHERE id = $1`,
    [userId],
  );
  const row = r.rows[0] ?? {
    generations_used: 0,
    subscription_until: null,
    plan: null,
    username: null,
  };
  const isOwner = !!OWNER_USERNAME && row.username === OWNER_USERNAME;
  const subUntil: Date | null = row.subscription_until
    ? new Date(row.subscription_until)
    : null;
  const isPremium =
    isOwner || (subUntil !== null && subUntil.getTime() > Date.now());
  const used: number = row.generations_used ?? 0;
  return {
    isOwner,
    isPremium,
    used,
    remaining: Math.max(0, FREE_QUOTA - used),
    subscriptionUntil: subUntil,
    plan: row.plan ?? null,
  };
}

async function consumeQuota(userId: number): Promise<void> {
  const status = await getUserStatus(userId);
  if (status.isPremium) return;
  await pool.query(
    `UPDATE bot_users SET generations_used = generations_used + 1 WHERE id = $1`,
    [userId],
  );
}

async function grantSubscription(
  userId: number,
  days: number,
  plan = "premium",
): Promise<Date> {
  const r = await pool.query(
    `INSERT INTO bot_users (id, subscription_until, plan)
     VALUES ($1, now() + ($2 || ' days')::interval, $3)
     ON CONFLICT (id) DO UPDATE SET
       subscription_until = GREATEST(COALESCE(bot_users.subscription_until, now()), now()) + ($2 || ' days')::interval,
       plan = EXCLUDED.plan
     RETURNING subscription_until`,
    [userId, String(days), plan],
  );
  return new Date(r.rows[0].subscription_until);
}

async function revokeSubscription(userId: number): Promise<void> {
  await pool.query(
    `UPDATE bot_users SET subscription_until = NULL, plan = NULL WHERE id = $1`,
    [userId],
  );
}

async function resetQuota(userId: number): Promise<void> {
  await pool.query(
    `UPDATE bot_users SET generations_used = 0 WHERE id = $1`,
    [userId],
  );
}

function isOwnerCtx(ctx: BotContext): boolean {
  return !!OWNER_USERNAME && ctx.from?.username === OWNER_USERNAME;
}

async function adminStats(): Promise<{
  totalUsers: number;
  premium: number;
  totalGenerations: number;
  today: number;
  activeWeek: number;
}> {
  const a = await pool.query(`SELECT COUNT(*)::int AS c FROM bot_users`);
  const b = await pool.query(
    `SELECT COUNT(*)::int AS c FROM bot_users WHERE subscription_until > now()`,
  );
  const c = await pool.query(`SELECT COUNT(*)::int AS c FROM bot_generations`);
  const d = await pool.query(
    `SELECT COUNT(*)::int AS c FROM bot_generations WHERE created_at > now() - interval '1 day'`,
  );
  const e = await pool.query(
    `SELECT COUNT(*)::int AS c FROM bot_users WHERE last_seen > now() - interval '7 days'`,
  );
  return {
    totalUsers: a.rows[0].c,
    premium: b.rows[0].c,
    totalGenerations: c.rows[0].c,
    today: d.rows[0].c,
    activeWeek: e.rows[0].c,
  };
}

async function listAllUsers(): Promise<
  Array<{
    id: number;
    username: string | null;
    first_name: string | null;
    generations_used: number;
    subscription_until: Date | null;
    plan: string | null;
  }>
> {
  const r = await pool.query(
    `SELECT id, username, first_name, generations_used, subscription_until, plan
     FROM bot_users ORDER BY last_seen DESC LIMIT 50`,
  );
  return r.rows;
}

async function getAllUserIds(): Promise<number[]> {
  const r = await pool.query(`SELECT id FROM bot_users`);
  return r.rows.map((row: { id: string | number }) => Number(row.id));
}

async function costsSummary(): Promise<{
  today: number;
  week: number;
  month: number;
  total: number;
}> {
  const r = await pool.query(`
    SELECT
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '1 day'), 0) AS today,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '7 days'), 0) AS week,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS month,
      COALESCE(SUM(cost_usd), 0) AS total
    FROM bot_usage
  `);
  const row = r.rows[0];
  return {
    today: Number(row.today),
    week: Number(row.week),
    month: Number(row.month),
    total: Number(row.total),
  };
}

const rateMap = new Map<number, number[]>();

function checkRate(userId: number, isPremium: boolean): boolean {
  const limit = isPremium ? RATE_PREMIUM_PER_MIN : RATE_FREE_PER_MIN;
  const now = Date.now();
  const window = 60_000;
  const arr = (rateMap.get(userId) ?? []).filter((t) => now - t < window);
  if (arr.length >= limit) {
    rateMap.set(userId, arr);
    return false;
  }
  arr.push(now);
  rateMap.set(userId, arr);
  return true;
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function calcTextCost(input: number, output: number): number {
  return (input / 1000) * PRICE_INPUT_PER_1K + (output / 1000) * PRICE_OUTPUT_PER_1K;
}

async function trackUsage(
  userId: number | undefined,
  kind: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO bot_usage (user_id, kind, model, input_tokens, output_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, kind, model, inputTokens, outputTokens, cost],
    );
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "usage log failed");
  }
}

async function compose(
  system: string,
  user: string,
  max = 2000,
  meta: { userId?: number; kind: string } = { kind: "compose" },
): Promise<string> {
  const res = await textEngine.messages.create({
    model: TEXT_MODEL,
    max_tokens: Math.max(max, 1024),
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = extractText(res.content);
  const inT = res.usage?.input_tokens ?? 0;
  const outT = res.usage?.output_tokens ?? 0;
  await trackUsage(meta.userId, meta.kind, TEXT_MODEL, inT, outT, calcTextCost(inT, outT));
  return text;
}

async function composeWithHistory(
  system: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  user: string,
  max = 2000,
  meta: { userId?: number; kind: string } = { kind: "compose_history" },
): Promise<string> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    ...history.slice(-8),
    { role: "user", content: user },
  ];
  const res = await textEngine.messages.create({
    model: TEXT_MODEL,
    max_tokens: Math.max(max, 1024),
    system,
    messages,
  });
  const text = extractText(res.content);
  const inT = res.usage?.input_tokens ?? 0;
  const outT = res.usage?.output_tokens ?? 0;
  await trackUsage(meta.userId, meta.kind, TEXT_MODEL, inT, outT, calcTextCost(inT, outT));
  return text;
}

async function renderImage(
  prompt: string,
  meta: { userId?: number; kind: string } = { kind: "image" },
): Promise<Buffer> {
  const res = await imageEngine.models.generateContent({
    model: IMAGE_MODEL,
    contents: prompt,
  });
  await trackUsage(meta.userId, meta.kind, IMAGE_MODEL, 0, 0, PRICE_IMAGE);
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) return Buffer.from(data, "base64");
  }
  throw new Error("Image not returned");
}

async function describePhoto(
  imageUrl: string,
  system: string,
  instruction: string,
  meta: { userId?: number; kind: string } = { kind: "vision" },
): Promise<string> {
  const fetched = await fetch(imageUrl);
  if (!fetched.ok) throw new Error(`Image fetch failed (${fetched.status})`);
  const arrayBuf = await fetched.arrayBuffer();
  const base64 = Buffer.from(arrayBuf).toString("base64");
  const contentType = fetched.headers.get("content-type") ?? "image/jpeg";
  const mediaType = (contentType.split(";")[0] ?? "image/jpeg").trim() as
    | "image/jpeg"
    | "image/png"
    | "image/gif"
    | "image/webp";
  const res = await textEngine.messages.create({
    model: TEXT_MODEL,
    max_tokens: 1500,
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: instruction },
        ],
      },
    ],
  });
  const text = extractText(res.content);
  const inT = res.usage?.input_tokens ?? 0;
  const outT = res.usage?.output_tokens ?? 0;
  await trackUsage(meta.userId, meta.kind, TEXT_MODEL, inT, outT, calcTextCost(inT, outT));
  return text;
}

const PROMPT_POST = `Ты — топовый копирайтер для Telegram, Instagram и LinkedIn в 2026 году.
Задача: написать готовый к публикации пост, который дочитывается до конца.

Жёсткие правила:
- Структура: цепляющий хук (1 строка) → раскрытие пользы или истории → 2–3 конкретных тейкауэя → сильный CTA.
- Короткие абзацы (1–3 строки), пустая строка между блоками.
- Эмодзи: максимум 1–2 на пост, только если они усиливают смысл.
- Никаких клише: "в современном мире", "сегодня я расскажу".
- Конкретика, цифры, примеры. Никакой воды.
- 700–1500 знаков. Без markdown-разметки (**, ##, ---) — Telegram её не любит.
- Верни ТОЛЬКО сам пост, без предисловий и пояснений.`;

const PROMPT_IDEAS = `Ты — стратег по контенту для Telegram, Instagram и YouTube Shorts в 2026 году.
Сгенерируй 10 свежих идей постов под нишу пользователя.

Каждая идея — конкретная, не общая. Не "напиши о трендах", а "разбор: как X сделал Y за Z дней с конкретными цифрами".

Формат каждой идеи:
N. <Цепляющее название идеи>
   📌 Формат: <пост / карусель / Reels / опрос / разбор / список>
   🎯 Зачем смотреть: <одна строка про конкретную пользу>

Идеи разнообразные по форматам и углам. Никакого markdown, никаких пояснений сверху или снизу — только список.`;

const PROMPT_HOOKS = `Ты — эксперт по вирусным первым строкам.
Дай 10 разных вариантов хука под тему пользователя.

Используй разные приёмы: вопрос, парадокс, цифра, провокация, инсайт, история-зацепка, противопоставление, ошибка, утверждение-якорь, неожиданное сравнение.

Каждый хук — одна короткая мощная фраза, после которой невозможно не читать дальше. Без воды, без воды-вступлений.

Формат:
1. <хук>
2. <хук>
...
10. <хук>

Без markdown. Без объяснений.`;

const PROMPT_HEADLINES = `Сгенерируй 10 цепляющих заголовков под тему пользователя для постов и видео.

Принципы: конкретика, цифры, обещание выгоды, любопытство, контраст, конкретный субъект.
Каждый заголовок — до 70 знаков. Никаких многоточий и воды.

Просто пронумерованный список 1..10. Без markdown, без комментариев.`;

const PROMPT_PLAN = `Ты — контент-стратег. Составь контент-план на 7 дней для Telegram-канала под нишу пользователя.

Для каждого дня (Пн–Вс):
📅 День — <тема дня>
✍️ Формат: <пост / опрос / Reels / карусель / экспертный разбор / личная история>
🎯 Цель: <вовлечение / прогрев / продажа / экспертность / трафик>
💡 Идея: <конкретная идея в 1–2 строки, готовая к работе>

Чередуй цели и форматы. План готов к публикации без доработок. Без markdown.`;

const PROMPT_ANALYZE = `Ты — редактор и аналитик контента с опытом 10+ лет.
Разбери присланный пост по структуре:

1️⃣ Сильные стороны (3–5 пунктов)
2️⃣ Слабые места (3–5 пунктов)
3️⃣ Что улучшить — конкретные правки, не общие слова
4️⃣ Прогноз вовлечения: низкое / среднее / высокое — и почему именно
5️⃣ Готовая улучшенная версия первого абзаца

Будь честным, без воды, по делу. Без markdown.`;

const PROMPT_REPURPOSE = `Перепиши присланный пост под 4 платформы, сохранив суть, но адаптировав форму:

🔵 Telegram (700–1200 знаков, экспертный, абзацами)
🟣 Instagram (карусель, 6 слайдов: для каждого слайда — заголовок + 2–3 строки)
🔴 YouTube Shorts / TikTok (сценарий 30 сек: хук, тело, CTA)
🔷 LinkedIn (профессиональный тон, первые 2 строки — крюк до сворачивания)

Раздели результат заголовками платформ. Без markdown.`;

const PROMPT_HASHTAGS = `Подбери хэштеги под тему пользователя.
Дай три группы:

🔥 ВЧ (5 хэштегов с большой аудиторией)
🎯 СЧ (10 хэштегов, релевантных нише)
💎 НЧ / нишевые (10 узких хэштегов с активной аудиторией)

Без объяснений, просто хэштеги через пробел в каждой группе.`;

const PROMPT_REWRITE = `Перепиши текст пользователя, сохранив смысл, но улучшив:
- структуру и ритм
- хук в начале
- конкретику вместо абстракций
- сильный финал с CTA

Сохрани длину ±20%. Верни ТОЛЬКО переписанный текст, без markdown.`;

const PROMPT_CAPTION = `Ты — креативный копирайтер.
По присланному изображению создай:

1. Цепляющий заголовок (до 60 знаков)
2. Подпись для Instagram / Telegram (3–5 предложений с хуком)
3. 10 релевантных хэштегов

Будь конкретным и эмоциональным, без воды. Без markdown.`;

const PROMPT_IMG_PROMPT = `Сформулируй детальный промпт на английском для генерации иллюстрации к посту.
Стиль: современный, чистый, фотореалистичный или premium-иллюстрация.
Без текста на изображении. Только сам промпт, без пояснений.`;

const PROMPT_IMG_TRANSLATE = `Переведи и улучши промпт для генерации изображения.
Сделай его детальным на английском: добавь стиль, освещение, композицию, материалы, настроение.
Только промпт, без пояснений.`;

type ActionKey =
  | "post_write"
  | "ideas"
  | "hooks"
  | "headlines"
  | "image"
  | "plan"
  | "analyze"
  | "repurpose"
  | "hashtags"
  | "rewrite"
  | "caption"
  | "brand"
  | "schedule"
  | "buy"
  | "history"
  | "help";

const ACTIONS: Record<ActionKey, { ru: string; en: string }> = {
  post_write: { ru: "✍️ Написать пост", en: "✍️ Write a post" },
  ideas: { ru: "💡 Идеи контента", en: "💡 Content ideas" },
  hooks: { ru: "🪝 Хуки", en: "🪝 Hooks" },
  headlines: { ru: "📰 Заголовки", en: "📰 Headlines" },
  image: { ru: "🎨 Картинка", en: "🎨 Image" },
  plan: { ru: "📅 Контент-план", en: "📅 Content plan" },
  analyze: { ru: "🔍 Анализ поста", en: "🔍 Post analysis" },
  repurpose: { ru: "♻️ Адаптировать", en: "♻️ Repurpose" },
  hashtags: { ru: "#️⃣ Хэштеги", en: "#️⃣ Hashtags" },
  rewrite: { ru: "✨ Переписать", en: "✨ Rewrite" },
  caption: { ru: "📷 Подпись к фото", en: "📷 Photo caption" },
  brand: { ru: "🎯 Мой бренд", en: "🎯 My brand" },
  schedule: { ru: "🗓 Автопостинг", en: "🗓 Autopost" },
  buy: { ru: "💎 Подписка", en: "💎 Subscription" },
  history: { ru: "📚 История", en: "📚 History" },
  help: { ru: "ℹ️ Помощь", en: "ℹ️ Help" },
};

function labels(key: ActionKey): string[] {
  return [ACTIONS[key].ru, ACTIONS[key].en];
}

function label(key: ActionKey, lang: Lang): string {
  return ACTIONS[key][lang];
}

function mainMenu(lang: Lang): Keyboard {
  return new Keyboard()
    .text(label("post_write", lang)).text(label("ideas", lang)).row()
    .text(label("hooks", lang)).text(label("headlines", lang)).row()
    .text(label("image", lang)).text(label("plan", lang)).row()
    .text(label("analyze", lang)).text(label("repurpose", lang)).row()
    .text(label("hashtags", lang)).text(label("rewrite", lang)).row()
    .text(label("caption", lang)).text(label("schedule", lang)).row()
    .text(label("brand", lang)).text(label("buy", lang)).row()
    .text(label("history", lang)).text(label("help", lang))
    .resized()
    .persistent();
}

function postFollowupKeyboard(lang: Lang): InlineKeyboard {
  const t = STRINGS[lang];
  return new InlineKeyboard()
    .text(t.followRegen, "post_regen")
    .text(t.followStronger, "post_stronger").row()
    .text(t.followShorter, "post_shorter")
    .text(t.followLonger, "post_longer").row()
    .text(t.followImage, "post_image")
    .text(t.followHashtags, "post_hashtags").row()
    .text(t.followRepurpose, "post_repurpose");
}

const STRINGS = {
  ru: {
    pickLang: "🌐 Выберите язык / Choose language",
    langSet: "✅ Язык установлен: Русский",
    captchaTitle: (target: string) =>
      `🛡️ Проверка: вы человек?\n\nНажмите на эмодзи: ${target}`,
    captchaWrong: "❌ Неверно. Попробуйте ещё раз.",
    captchaOk: "✅ Проверка пройдена.",
    welcome: (name: string, status: string, userId: number) =>
      `👋 Добро пожаловать в ${BRAND}, ${name}!

${BRAND_TAGLINE_RU}

🎯 Что умеет:
✍️ Готовые посты под Telegram, Instagram, LinkedIn
💡 10 свежих идей под нишу
🪝 Цепляющие хуки и заголовки
🎨 Премиум-картинки к постам
📅 Контент-план на 7 дней
🔍 Разбор постов и прогноз вовлечения
♻️ Адаптация одного поста под 4 платформы
#️⃣ Хэштеги (ВЧ/СЧ/НЧ)
📷 Подписи к фото
✨ Переписывание слабых текстов
🗓 Автопостинг по расписанию
💎 Подписка через Telegram Stars

📊 Ваш статус: ${status}
🆔 Ваш ID: \`${userId}\`

Начните с настройки бренда (🎯 Мой бренд) — и весь контент будет в вашем стиле.`,
    menuPick: "Выберите действие 👇",
    contextCleared: "Контекст очищен. С чего начнём?",
    rateLimited: "⏳ Слишком быстро. Подожди минутку и попробуй снова.",
    askPostTopic:
      "О чём пост? Опишите тему в одном-двух предложениях.\nМожно добавить детали: что хотите донести, для какой платформы.",
    askIdeasNiche: "Под какую нишу сгенерировать 10 идей?",
    askHooksTopic: "Под какую тему сгенерировать 10 хуков?",
    askHeadlinesTopic: "Под какую тему сделать 10 заголовков?",
    askImagePrompt:
      "Опишите картинку, которую нужно сгенерировать.\nЧем подробнее — тем лучше: стиль, цвета, композиция, настроение.",
    askPlanNiche: "Под какую нишу составить план на 7 дней?",
    askAnalyze:
      "Пришлите текст поста — разберу по полочкам и дам прогноз вовлечения.",
    askRepurpose:
      "Пришлите пост — адаптирую под Telegram, Instagram, Shorts и LinkedIn.",
    askHashtags: "Под какую тему подобрать хэштеги?",
    askRewrite: "Пришлите текст — перепишу сильнее, без воды.",
    askCaption: "Пришлите фото — напишу заголовок, подпись и подберу хэштеги.",
    needCaptionMode:
      "Чтобы сделать подпись к фото, нажмите кнопку и пришлите изображение.",
    photoFail: (msg: string) => `Ошибка обработки фото: ${msg}`,
    historyEmpty:
      "История пока пустая. Сгенерируйте что-нибудь и оно появится здесь.",
    historyTitle: "📚 Последние 10 генераций:",
    brandStep1:
      "🎯 Настройка бренда — шаг 1/4\n\nОпишите свою нишу одним предложением.\nНапример: «Криптоинвестиции для новичков» или «Домашняя выпечка без сахара».",
    brandStep2:
      "Шаг 2/4 — кто ваша аудитория? Опишите коротко (возраст, интересы, уровень).",
    brandStep3:
      "Шаг 3/4 — какой тон голоса?\nНапример: дружеский, экспертный, провокационный, ироничный, серьёзный.",
    brandStep4:
      "Шаг 4/4 — на каком языке писать контент по умолчанию? (русский / english / другой)",
    brandSaved: (ctx: string) =>
      `✅ Бренд настроен!\n\n${ctx}Теперь весь контент будет в вашем стиле.`,
    fallback:
      "Выберите действие из меню или напишите /menu, чтобы открыть его снова.",
    workingRegen: "⚙️ Делаю другой вариант…",
    workingStronger: "⚙️ Усиливаю…",
    workingShorter: "⚙️ Сокращаю…",
    workingLonger: "⚙️ Расширяю…",
    workingImage: "🎨 Рисую картинку к посту…",
    workingHashtags: "⚙️ Подбираю хэштеги…",
    workingRepurpose: "⚙️ Адаптирую под 4 платформы…",
    workingGenImage: "🎨 Готовлю изображение… (15–30 сек)",
    imageReady: "🎨 Готово",
    noLastPost: "Нет поста для действия. Сначала сгенерируйте пост.",
    imageFail: (msg: string) => `Не удалось подготовить картинку: ${msg}`,
    postFollowupHint:
      "Можно написать правки текстом, и я перепишу с учётом контекста.",
    paywallTitle: "🔒 Пробный доступ исчерпан",
    paywallBody: (n: number, contact: string, id: number) => {
      const c = contact ? `или напишите ${contact}` : "";
      return `Вы использовали все ${n} бесплатных генераций ${BRAND}.\n\nОформите подписку через Telegram Stars (💎 Подписка) ${c}.\n\nВаш ID для активации: \`${id}\``;
    },
    statusOwner: "👑 Владелец — безлимитный доступ",
    statusPremium: (plan: string, date: string) =>
      `💎 ${plan} — активна до ${date}`,
    statusFree: (used: number, n: number, left: number) =>
      `🆓 Пробный доступ: ${used}/${n} использовано (осталось ${left})`,
    profileTitle: `👤 Профиль ${BRAND}`,
    profileFooterPremium: "✅ Доступ ко всем функциям без ограничений.",
    profileFooterFree: (contact: string) =>
      contact
        ? `Когда закончится пробник — оформите подписку через 💎 Подписка или напишите ${contact}.`
        : `Когда закончится пробник — оформите подписку через 💎 Подписка.`,
    help: `📖 ${BRAND} — команды:

✍️ Написать пост — пришлите тему, получите готовый пост
💡 Идеи контента — 10 свежих идей под нишу
🪝 Хуки — 10 цепляющих первых строк
📰 Заголовки — 10 заголовков под тему
🎨 Картинка — изображение по описанию
📅 Контент-план — план на 7 дней
🔍 Анализ поста — разбор и прогноз вовлечения
♻️ Адаптировать — один пост → 4 платформы
#️⃣ Хэштеги — три группы под тему
✨ Переписать — улучшу ваш текст
📷 Подпись к фото — пришлите фото, получите подпись
🗓 Автопостинг — отправка постов в канал по расписанию
🎯 Мой бренд — настройка стиля и ниши
💎 Подписка — оплата через Telegram Stars
📚 История — последние 10 генераций

Команды: /start /menu /brand /me /buy /schedule /scheduled /reset /lang`,
    followRegen: "🔁 Другой вариант",
    followStronger: "✨ Сильнее",
    followShorter: "📏 Короче",
    followLonger: "📖 Длиннее",
    followImage: "🎨 Картинку к посту",
    followHashtags: "#️⃣ Хэштеги",
    followRepurpose: "♻️ В другие соцсети",
    langChanged: "Язык изменён.",
    buyTitle: "💎 Подписка через Telegram Stars",
    buyBody:
      "Оплата проходит прямо в Telegram. Подписка активируется автоматически после оплаты.",
    payOk: (days: number, until: string) =>
      `✅ Подписка активирована на ${days} дн.\nДействует до: ${until}`,
    payFail: "Не удалось обработать оплату. Звёзды не списаны или будут возвращены.",
    askScheduleChannel:
      "🗓 Автопостинг\n\nШаг 1/3 — пришлите @username канала или его ID.\n\nВажно: добавьте бота в канал как администратора с правом публикации.",
    askScheduleText:
      "Шаг 2/3 — пришлите текст поста (или нажмите ✍️ Написать пост, чтобы сначала подготовить).",
    askScheduleWhen:
      "Шаг 3/3 — когда отправить?\nФормат: YYYY-MM-DD HH:MM (по UTC) или относительно: «через 2 часа», «через 30 минут».",
    scheduleSaved: (when: string, id: number) =>
      `✅ Запланировано на ${when} (UTC). ID: ${id}\n\nКоманда /scheduled — список всех запланированных. /cancel <id> — отмена.`,
    scheduleBadDate:
      "Не понял дату. Используй формат YYYY-MM-DD HH:MM или «через N минут / часов / дней».",
    scheduledEmpty: "Запланированных постов нет.",
    scheduledTitle: "🗓 Запланированные посты:",
    scheduledItem: (
      id: number,
      ch: string,
      when: string,
      preview: string,
      status: string,
    ) => `#${id} → ${ch}\n⏰ ${when} (UTC) — ${status}\n${preview}`,
    cancelOk: (id: number) => `❌ Пост #${id} отменён.`,
    cancelNotFound: "Пост не найден или уже отправлен.",
    sendChannelFail: (e: string) => `❌ Ошибка отправки в канал: ${e}`,
  },
  en: {
    pickLang: "🌐 Choose language / Выберите язык",
    langSet: "✅ Language set: English",
    captchaTitle: (target: string) =>
      `🛡️ Verification: are you human?\n\nTap the emoji: ${target}`,
    captchaWrong: "❌ Wrong. Try again.",
    captchaOk: "✅ Verified.",
    welcome: (name: string, status: string, userId: number) =>
      `👋 Welcome to ${BRAND}, ${name}!

${BRAND_TAGLINE_EN}

🎯 What it does:
✍️ Ready-to-publish posts for Telegram, Instagram, LinkedIn
💡 10 fresh content ideas for your niche
🪝 Attention-grabbing hooks and headlines
🎨 Premium images for posts
📅 7-day content plan
🔍 Post breakdown with engagement forecast
♻️ Adapts a single post to 4 platforms
#️⃣ Hashtag bundles (high/mid/low volume)
📷 Captions for any photo
✨ Rewrites weak copy into strong copy
🗓 Scheduled autoposting
💎 Subscription via Telegram Stars

📊 Your status: ${status}
🆔 Your ID: \`${userId}\`

Start by setting your brand (🎯 My brand) — and all content will match your style.`,
    menuPick: "Pick an action 👇",
    contextCleared: "Context cleared. Where do we start?",
    rateLimited: "⏳ Too fast. Wait a minute and try again.",
    askPostTopic:
      "What's the post about? Describe the topic in one or two sentences.\nYou can add details: the message, the platform.",
    askIdeasNiche: "What niche should I generate 10 ideas for?",
    askHooksTopic: "What topic should I write 10 hooks for?",
    askHeadlinesTopic: "What topic should I write 10 headlines for?",
    askImagePrompt:
      "Describe the image you want.\nThe more detail — the better: style, colors, composition, mood.",
    askPlanNiche: "What niche should I build a 7-day plan for?",
    askAnalyze:
      "Send the post text — I'll break it down and forecast engagement.",
    askRepurpose:
      "Send the post — I'll adapt it for Telegram, Instagram, Shorts and LinkedIn.",
    askHashtags: "What topic should I pick hashtags for?",
    askRewrite: "Send the text — I'll rewrite it stronger, no fluff.",
    askCaption: "Send a photo — I'll write a headline, caption and pick hashtags.",
    needCaptionMode:
      "To caption a photo, tap the button first and then send the image.",
    photoFail: (msg: string) => `Photo processing error: ${msg}`,
    historyEmpty: "History is empty. Generate something and it will show up here.",
    historyTitle: "📚 Last 10 generations:",
    brandStep1:
      "🎯 Brand setup — step 1/4\n\nDescribe your niche in one sentence.\nFor example: \"Crypto investing for beginners\" or \"Sugar-free home baking\".",
    brandStep2:
      "Step 2/4 — who is your audience? Describe briefly (age, interests, level).",
    brandStep3:
      "Step 3/4 — what's your tone of voice?\nFor example: friendly, expert, provocative, ironic, serious.",
    brandStep4:
      "Step 4/4 — what's the default content language? (english / russian / other)",
    brandSaved: (ctx: string) =>
      `✅ Brand saved!\n\n${ctx}All content will now match your style.`,
    fallback: "Pick an action from the menu or type /menu to open it again.",
    workingRegen: "⚙️ Making another version…",
    workingStronger: "⚙️ Making it stronger…",
    workingShorter: "⚙️ Shortening…",
    workingLonger: "⚙️ Expanding…",
    workingImage: "🎨 Drawing an image for the post…",
    workingHashtags: "⚙️ Picking hashtags…",
    workingRepurpose: "⚙️ Adapting to 4 platforms…",
    workingGenImage: "🎨 Preparing image… (15–30 sec)",
    imageReady: "🎨 Done",
    noLastPost: "No post to act on. Generate a post first.",
    imageFail: (msg: string) => `Image preparation failed: ${msg}`,
    postFollowupHint:
      "You can send edits as text, and I'll rewrite with full context.",
    paywallTitle: "🔒 Free trial finished",
    paywallBody: (n: number, contact: string, id: number) => {
      const c = contact ? `or message ${contact}` : "";
      return `You've used all ${n} free generations of ${BRAND}.\n\nGet a subscription via Telegram Stars (💎 Subscription) ${c}.\n\nYour activation ID: \`${id}\``;
    },
    statusOwner: "👑 Owner — unlimited access",
    statusPremium: (plan: string, date: string) =>
      `💎 ${plan} — active until ${date}`,
    statusFree: (used: number, n: number, left: number) =>
      `🆓 Free trial: ${used}/${n} used (${left} left)`,
    profileTitle: `👤 ${BRAND} profile`,
    profileFooterPremium: "✅ All features available, no limits.",
    profileFooterFree: (contact: string) =>
      contact
        ? `When the trial runs out — subscribe via 💎 Subscription or message ${contact}.`
        : `When the trial runs out — subscribe via 💎 Subscription.`,
    help: `📖 ${BRAND} — commands:

✍️ Write a post — send a topic, get a ready post
💡 Content ideas — 10 fresh niche ideas
🪝 Hooks — 10 attention-grabbing first lines
📰 Headlines — 10 headlines for any topic
🎨 Image — image from a description
📅 Content plan — 7-day plan
🔍 Post analysis — breakdown and engagement forecast
♻️ Repurpose — one post → 4 platforms
#️⃣ Hashtags — three bundles per topic
✨ Rewrite — make weak copy strong
📷 Photo caption — send a photo, get a caption
🗓 Autopost — schedule posts to a channel
🎯 My brand — set niche and style
💎 Subscription — pay with Telegram Stars
📚 History — last 10 generations

Commands: /start /menu /brand /me /buy /schedule /scheduled /reset /lang`,
    followRegen: "🔁 Another version",
    followStronger: "✨ Stronger",
    followShorter: "📏 Shorter",
    followLonger: "📖 Longer",
    followImage: "🎨 Image for the post",
    followHashtags: "#️⃣ Hashtags",
    followRepurpose: "♻️ For other platforms",
    langChanged: "Language updated.",
    buyTitle: "💎 Subscription via Telegram Stars",
    buyBody:
      "Payment is processed directly inside Telegram. Subscription activates automatically after payment.",
    payOk: (days: number, until: string) =>
      `✅ Subscription activated for ${days} days.\nValid until: ${until}`,
    payFail: "Payment processing failed. Stars were not charged or will be refunded.",
    askScheduleChannel:
      "🗓 Autopost\n\nStep 1/3 — send the channel @username or its ID.\n\nImportant: add the bot to the channel as administrator with posting rights.",
    askScheduleText:
      "Step 2/3 — send the post text (or tap ✍️ Write a post first to prepare one).",
    askScheduleWhen:
      "Step 3/3 — when to send?\nFormat: YYYY-MM-DD HH:MM (UTC) or relative: \"in 2 hours\", \"in 30 minutes\".",
    scheduleSaved: (when: string, id: number) =>
      `✅ Scheduled for ${when} (UTC). ID: ${id}\n\nCommand /scheduled — list all scheduled. /cancel <id> — cancel.`,
    scheduleBadDate:
      "Couldn't parse the date. Use format YYYY-MM-DD HH:MM or \"in N minutes / hours / days\".",
    scheduledEmpty: "No scheduled posts.",
    scheduledTitle: "🗓 Scheduled posts:",
    scheduledItem: (
      id: number,
      ch: string,
      when: string,
      preview: string,
      status: string,
    ) => `#${id} → ${ch}\n⏰ ${when} (UTC) — ${status}\n${preview}`,
    cancelOk: (id: number) => `❌ Post #${id} cancelled.`,
    cancelNotFound: "Post not found or already sent.",
    sendChannelFail: (e: string) => `❌ Channel send error: ${e}`,
  },
} as const;

const CAPTCHA_POOL = ["🍎", "🍊", "🍋", "🍌", "🍇", "🍓", "🍒", "🥝", "🍑", "🍍"];

function pickCaptcha(): { target: string; options: string[] } {
  const shuffled = [...CAPTCHA_POOL].sort(() => Math.random() - 0.5).slice(0, 4);
  const target = shuffled[Math.floor(Math.random() * shuffled.length)];
  return { target: target ?? "🍎", options: shuffled };
}

function captchaKeyboard(options: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  options.forEach((emoji, i) => {
    kb.text(emoji, `cap_${emoji}`);
    if (i === 1) kb.row();
  });
  return kb;
}

function langKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", "lang_ru")
    .text("🇬🇧 English", "lang_en");
}

async function loadOnboarding(userId: number): Promise<{
  lang: Lang | null;
  captchaPassed: boolean;
  captchaTarget: string | null;
}> {
  const r = await pool.query(
    `SELECT ui_lang, captcha_passed, captcha_target FROM bot_users WHERE id = $1`,
    [userId],
  );
  const row = r.rows[0] ?? {};
  return {
    lang: (row.ui_lang as Lang | undefined) ?? null,
    captchaPassed: row.captcha_passed === true,
    captchaTarget: (row.captcha_target as string | undefined) ?? null,
  };
}

async function saveLang(userId: number, lang: Lang): Promise<void> {
  await pool.query(
    `INSERT INTO bot_users (id, ui_lang) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET ui_lang = EXCLUDED.ui_lang`,
    [userId, lang],
  );
}

async function setCaptchaTarget(userId: number, target: string | null): Promise<void> {
  await pool.query(`UPDATE bot_users SET captcha_target = $2 WHERE id = $1`, [
    userId,
    target,
  ]);
}

async function markCaptchaPassed(userId: number): Promise<void> {
  await pool.query(
    `UPDATE bot_users SET captcha_passed = true, captcha_target = NULL WHERE id = $1`,
    [userId],
  );
}

async function refreshSessionFromDb(ctx: BotContext): Promise<void> {
  if (!ctx.from) return;
  const ob = await loadOnboarding(ctx.from.id);
  if (ob.lang) ctx.session.lang = ob.lang;
  ctx.session.onboarded = ob.lang !== null && ob.captchaPassed;
}

async function startOnboarding(ctx: BotContext): Promise<void> {
  await ctx.reply(STRINGS.ru.pickLang, { reply_markup: langKeyboard() });
}

async function sendCaptcha(ctx: BotContext, lang: Lang): Promise<void> {
  if (!ctx.from) return;
  const { target, options } = pickCaptcha();
  await setCaptchaTarget(ctx.from.id, target);
  await ctx.reply(STRINGS[lang].captchaTitle(target), {
    reply_markup: captchaKeyboard(options),
  });
}

function brandContext(brand: BrandProfile): string {
  const parts: string[] = [];
  if (brand.niche) parts.push(`Ниша: ${brand.niche}`);
  if (brand.audience) parts.push(`Аудитория: ${brand.audience}`);
  if (brand.tone) parts.push(`Тон голоса: ${brand.tone}`);
  if (brand.language) parts.push(`Язык: ${brand.language}`);
  if (parts.length === 0) return "";
  return `Профиль бренда:\n${parts.join("\n")}\n\n`;
}

function formatStatus(status: UserStatus, lang: Lang = "ru"): string {
  const s = STRINGS[lang];
  if (status.isOwner) return s.statusOwner;
  if (status.isPremium && status.subscriptionUntil) {
    const date = status.subscriptionUntil.toLocaleDateString(
      lang === "ru" ? "ru-RU" : "en-US",
    );
    return s.statusPremium(status.plan ?? "Premium", date);
  }
  return s.statusFree(status.used, FREE_QUOTA, status.remaining);
}

function paywallMessage(userId: number, lang: Lang): string {
  const s = STRINGS[lang];
  return `${s.paywallTitle}\n\n${s.paywallBody(FREE_QUOTA, OWNER_CONTACT, userId)}`;
}

async function ensureAccess(ctx: BotContext): Promise<boolean> {
  if (!ctx.from) return false;
  if (!ctx.session.onboarded) {
    await startOnboarding(ctx);
    return false;
  }
  const status = await getUserStatus(ctx.from.id);
  if (!status.isPremium && status.remaining <= 0) {
    ctx.session.mode = null;
    await ctx.reply(paywallMessage(ctx.from.id, ctx.session.lang), {
      parse_mode: "Markdown",
    });
    return false;
  }
  if (!checkRate(ctx.from.id, status.isPremium)) {
    await ctx.reply(STRINGS[ctx.session.lang].rateLimited);
    return false;
  }
  return true;
}

function buyKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  STAR_PLANS.forEach((p, i) => {
    kb.text(`${p.label} — ⭐ ${p.stars}`, `buy_${i}`);
    kb.row();
  });
  return kb;
}

function parseWhen(input: string): Date | null {
  const t = input.trim().toLowerCase();
  const rel = t.match(
    /(?:через|in)\s+(\d+)\s+(минут|мин|час|часа|часов|дн|день|дней|minute|minutes|hour|hours|day|days)/i,
  );
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]?.toLowerCase() ?? "";
    let ms = 0;
    if (/мин|minute/.test(unit)) ms = n * 60_000;
    else if (/час|hour/.test(unit)) ms = n * 3_600_000;
    else if (/дн|day|день/.test(unit)) ms = n * 86_400_000;
    if (ms > 0) return new Date(Date.now() + ms);
  }
  const abs = t.match(/^(\d{4})-(\d{2})-(\d{2})[ tT](\d{2}):(\d{2})/);
  if (abs) {
    const [, y, mo, d, h, mi] = abs;
    const date = new Date(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)),
    );
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

async function createScheduledPost(
  userId: number,
  channel: string,
  text: string,
  when: Date,
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO bot_scheduled_posts (user_id, channel, text, scheduled_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, channel, text, when],
  );
  return Number(r.rows[0].id);
}

async function listScheduled(
  userId: number,
): Promise<
  Array<{
    id: number;
    channel: string;
    text: string;
    scheduled_at: Date;
    status: string;
  }>
> {
  const r = await pool.query(
    `SELECT id, channel, text, scheduled_at, status
     FROM bot_scheduled_posts
     WHERE user_id = $1 AND status IN ('pending','sent','failed')
     ORDER BY scheduled_at DESC LIMIT 20`,
    [userId],
  );
  return r.rows.map((x: any) => ({
    id: Number(x.id),
    channel: x.channel,
    text: x.text,
    scheduled_at: new Date(x.scheduled_at),
    status: x.status,
  }));
}

async function cancelScheduled(userId: number, id: number): Promise<boolean> {
  const r = await pool.query(
    `UPDATE bot_scheduled_posts SET status = 'cancelled'
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id`,
    [id, userId],
  );
  return r.rows.length > 0;
}

function startScheduler(bot: Bot<BotContext>): void {
  const tick = async () => {
    try {
      const r = await pool.query(
        `SELECT id, user_id, channel, text FROM bot_scheduled_posts
         WHERE status = 'pending' AND scheduled_at <= now()
         ORDER BY scheduled_at LIMIT 20`,
      );
      for (const row of r.rows) {
        try {
          await bot.api.sendMessage(row.channel, row.text);
          await pool.query(
            `UPDATE bot_scheduled_posts SET status = 'sent', sent_at = now() WHERE id = $1`,
            [row.id],
          );
        } catch (err) {
          const msg = (err as Error).message;
          await pool.query(
            `UPDATE bot_scheduled_posts SET status = 'failed', error = $2 WHERE id = $1`,
            [row.id, msg.slice(0, 500)],
          );
          try {
            await bot.api.sendMessage(
              Number(row.user_id),
              STRINGS.ru.sendChannelFail(msg),
            );
          } catch {
            
          }
        }
      }
    } catch (e) {
      logger.error({ err: (e as Error).message }, "scheduler tick failed");
    }
  };
  setInterval(tick, 30_000);
  void tick();
}

const ADMIN_HELP = `🛠 Admin commands:
/stats — общая статистика
/users — последние 50 пользователей
/grant <user_id> <days> [plan] — выдать подписку
/revoke <user_id> — снять подписку
/reset_quota <user_id> — сбросить пробный лимит
/whois <user_id> — карточка пользователя
/broadcast <текст> — рассылка
/costs — затраты на инфраструктуру`;

export async function startBot(): Promise<void> {
  if (!TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN is not set — bot not started");
    return;
  }

  await ensureSchema();

  const bot = new Bot<BotContext>(TOKEN);

  bot.use(
    session({
      initial: (): SessionData => ({
        mode: null,
        brand: {},
        history: [],
        lang: "ru",
        onboarded: false,
        schedule: {},
      }),
    }),
  );

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      if (Object.keys(ctx.session.brand).length === 0) {
        ctx.session.brand = await loadBrand(ctx.from.id);
      }
      if (!ctx.session.onboarded) {
        await refreshSessionFromDb(ctx);
      }
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await upsertUser(ctx);
    await refreshSessionFromDb(ctx);
    if (!ctx.session.onboarded) {
      const ob = ctx.from
        ? await loadOnboarding(ctx.from.id)
        : { lang: null, captchaPassed: false, captchaTarget: null };
      if (!ob.lang) {
        await startOnboarding(ctx);
      } else {
        await sendCaptcha(ctx, ob.lang);
      }
      return;
    }
    if (!ctx.from) return;
    const lang = ctx.session.lang;
    const status = await getUserStatus(ctx.from.id);
    const name = ctx.from.first_name ?? (lang === "ru" ? "друг" : "friend");
    await ctx.reply(
      STRINGS[lang].welcome(name, formatStatus(status, lang), ctx.from.id),
      { parse_mode: "Markdown", reply_markup: mainMenu(lang) },
    );
  });

  bot.command("menu", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    const lang = ctx.session.lang;
    await ctx.reply(STRINGS[lang].menuPick, { reply_markup: mainMenu(lang) });
  });

  bot.command("lang", async (ctx) => {
    await ctx.reply(STRINGS.ru.pickLang, { reply_markup: langKeyboard() });
  });

  bot.command("me", async (ctx) => {
    if (!ctx.from) return;
    if (!(await ensureAccess(ctx))) return;
    const lang = ctx.session.lang;
    const s = STRINGS[lang];
    const status = await getUserStatus(ctx.from.id);
    const lines = [
      s.profileTitle,
      "",
      `📊 ${formatStatus(status, lang)}`,
      `🆔 ID: \`${ctx.from.id}\``,
      "",
      status.isPremium
        ? s.profileFooterPremium
        : s.profileFooterFree(OWNER_CONTACT),
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("reset", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = null;
    ctx.session.history = [];
    ctx.session.schedule = {};
    const lang = ctx.session.lang;
    await ctx.reply(STRINGS[lang].contextCleared, {
      reply_markup: mainMenu(lang),
    });
  });

  bot.command("admin", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    await ctx.reply(ADMIN_HELP);
  });

  bot.command("stats", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const s = await adminStats();
    await ctx.reply(
      `📊 ${BRAND} — статистика\n\n` +
        `👥 Всего: ${s.totalUsers}\n` +
        `💎 Премиум: ${s.premium}\n` +
        `🟢 Активных за неделю: ${s.activeWeek}\n` +
        `⚙️ Генераций всего: ${s.totalGenerations}\n` +
        `📅 За сутки: ${s.today}`,
    );
  });

  bot.command("users", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const users = await listAllUsers();
    if (users.length === 0) {
      await ctx.reply("Пользователей нет.");
      return;
    }
    const lines = users.map((u) => {
      const sub = u.subscription_until
        ? new Date(u.subscription_until).toISOString().slice(0, 10)
        : "—";
      const name = u.first_name ?? "—";
      const uname = u.username ? ` (@${u.username})` : "";
      return `\`${u.id}\` ${name}${uname}\n   gen: ${u.generations_used}, sub: ${sub}, plan: ${u.plan ?? "—"}`;
    });
    const chunks: string[] = [];
    let buf = "";
    for (const line of lines) {
      if (buf.length + line.length > 3500) {
        chunks.push(buf);
        buf = "";
      }
      buf += line + "\n\n";
    }
    if (buf) chunks.push(buf);
    for (const c of chunks) {
      await ctx.reply(c, { parse_mode: "Markdown" });
    }
  });

  bot.command("grant", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const userId = Number(args[0]);
    const days = Number(args[1]);
    const plan = args[2] ?? "premium";
    if (!userId || !days) {
      await ctx.reply("Формат: /grant <user_id> <days> [plan]");
      return;
    }
    const until = await grantSubscription(userId, days, plan);
    await ctx.reply(
      `✅ Подписка \`${plan}\` для \`${userId}\` активна до ${until.toLocaleString("ru-RU")}.`,
      { parse_mode: "Markdown" },
    );
    try {
      await bot.api.sendMessage(
        userId,
        `🎉 Активирована подписка ${BRAND} (${plan}) до ${until.toLocaleDateString("ru-RU")}.`,
      );
    } catch {
      
    }
  });

  bot.command("revoke", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const userId = Number(args[0]);
    if (!userId) {
      await ctx.reply("Формат: /revoke <user_id>");
      return;
    }
    await revokeSubscription(userId);
    await ctx.reply(`❌ Подписка пользователя \`${userId}\` снята.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("reset_quota", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const userId = Number(args[0]);
    if (!userId) {
      await ctx.reply("Формат: /reset_quota <user_id>");
      return;
    }
    await resetQuota(userId);
    await ctx.reply(`♻️ Пробный лимит пользователя \`${userId}\` сброшен.`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("whois", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const userId = Number(args[0]);
    if (!userId) {
      await ctx.reply("Формат: /whois <user_id>");
      return;
    }
    const status = await getUserStatus(userId);
    const r = await pool.query(
      `SELECT username, first_name, last_seen, created_at FROM bot_users WHERE id = $1`,
      [userId],
    );
    if (r.rows.length === 0) {
      await ctx.reply("Пользователь не найден.");
      return;
    }
    const u = r.rows[0];
    await ctx.reply(
      `👤 \`${userId}\`\n` +
        `Имя: ${u.first_name ?? "—"} ${u.username ? `(@${u.username})` : ""}\n` +
        `📊 ${formatStatus(status)}\n` +
        `Регистрация: ${new Date(u.created_at).toLocaleString("ru-RU")}\n` +
        `Последняя активность: ${new Date(u.last_seen).toLocaleString("ru-RU")}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("broadcast", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const text = ctx.message?.text?.replace(/^\/broadcast(\s+|$)/, "") ?? "";
    if (!text.trim()) {
      await ctx.reply("Формат: /broadcast <текст рассылки>");
      return;
    }
    const ids = await getAllUserIds();
    await ctx.reply(`📣 Начинаю рассылку для ${ids.length} пользователей…`);
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      try {
        await bot.api.sendMessage(id, text);
        ok++;
      } catch {
        fail++;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await ctx.reply(`📣 Готово. Доставлено: ${ok}, ошибок: ${fail}`);
  });

  bot.command("costs", async (ctx) => {
    if (!isOwnerCtx(ctx)) return;
    const c = await costsSummary();
    await ctx.reply(
      `💰 Затраты (USD)\n\n` +
        `За сутки: $${c.today.toFixed(4)}\n` +
        `За неделю: $${c.week.toFixed(4)}\n` +
        `За месяц: $${c.month.toFixed(4)}\n` +
        `Всего: $${c.total.toFixed(4)}`,
    );
  });

  bot.command("brand", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "brand_niche";
    await ctx.reply(STRINGS[ctx.session.lang].brandStep1);
  });

  bot.command("buy", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    const lang = ctx.session.lang;
    await ctx.reply(`${STRINGS[lang].buyTitle}\n\n${STRINGS[lang].buyBody}`, {
      reply_markup: buyKeyboard(),
    });
  });

  bot.hears(labels("buy"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    const lang = ctx.session.lang;
    await ctx.reply(`${STRINGS[lang].buyTitle}\n\n${STRINGS[lang].buyBody}`, {
      reply_markup: buyKeyboard(),
    });
  });

  bot.on("pre_checkout_query", async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (e) {
      logger.error({ err: (e as Error).message }, "pre_checkout failed");
    }
  });

  bot.on(":successful_payment", async (ctx) => {
    if (!ctx.from || !ctx.message?.successful_payment) return;
    const sp = ctx.message.successful_payment;
    const payload = sp.invoice_payload;
    const m = payload.match(/^plan_(\d+)$/);
    if (!m) return;
    const idx = Number(m[1]);
    const plan = STAR_PLANS[idx];
    if (!plan) return;
    const lang = ctx.session.lang;
    try {
      const until = await grantSubscription(ctx.from.id, plan.days, plan.label);
      await pool.query(
        `INSERT INTO bot_payments (user_id, charge_id, stars, plan, days)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (charge_id) DO NOTHING`,
        [
          ctx.from.id,
          sp.telegram_payment_charge_id,
          plan.stars,
          plan.label,
          plan.days,
        ],
      );
      await ctx.reply(
        STRINGS[lang].payOk(
          plan.days,
          until.toLocaleDateString(lang === "ru" ? "ru-RU" : "en-US"),
        ),
      );
    } catch (e) {
      logger.error({ err: (e as Error).message }, "grant after payment failed");
      await ctx.reply(STRINGS[lang].payFail);
    }
  });

  bot.command("schedule", async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "schedule_channel";
    ctx.session.schedule = {};
    await ctx.reply(STRINGS[ctx.session.lang].askScheduleChannel);
  });

  bot.command("scheduled", async (ctx) => {
    if (!ctx.from) return;
    if (!(await ensureAccess(ctx))) return;
    const items = await listScheduled(ctx.from.id);
    const lang = ctx.session.lang;
    if (items.length === 0) {
      await ctx.reply(STRINGS[lang].scheduledEmpty);
      return;
    }
    const lines = items.map((it) =>
      STRINGS[lang].scheduledItem(
        it.id,
        it.channel,
        it.scheduled_at.toISOString().replace("T", " ").slice(0, 16),
        it.text.slice(0, 80) + (it.text.length > 80 ? "…" : ""),
        it.status,
      ),
    );
    await ctx.reply(`${STRINGS[lang].scheduledTitle}\n\n${lines.join("\n\n")}`);
  });

  bot.command("cancel", async (ctx) => {
    if (!ctx.from) return;
    if (!(await ensureAccess(ctx))) return;
    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    const id = Number(args[0]);
    const lang = ctx.session.lang;
    if (!id) {
      await ctx.reply("Формат: /cancel <id>");
      return;
    }
    const ok = await cancelScheduled(ctx.from.id, id);
    await ctx.reply(
      ok ? STRINGS[lang].cancelOk(id) : STRINGS[lang].cancelNotFound,
    );
  });

  bot.hears(labels("schedule"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "schedule_channel";
    ctx.session.schedule = {};
    await ctx.reply(STRINGS[ctx.session.lang].askScheduleChannel);
  });

  bot.hears(labels("help"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    await ctx.reply(STRINGS[ctx.session.lang].help);
  });

  bot.hears(labels("post_write"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "post_topic";
    ctx.session.history = [];
    await ctx.reply(STRINGS[ctx.session.lang].askPostTopic);
  });

  bot.hears(labels("ideas"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "idea_niche";
    const brand = ctx.session.brand;
    if (brand.niche) {
      await produceIdeas(ctx, brand.niche);
      ctx.session.mode = null;
    } else {
      await ctx.reply(STRINGS[ctx.session.lang].askIdeasNiche);
    }
  });

  bot.hears(labels("hooks"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "hook_topic";
    await ctx.reply(STRINGS[ctx.session.lang].askHooksTopic);
  });

  bot.hears(labels("headlines"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "headline_topic";
    await ctx.reply(STRINGS[ctx.session.lang].askHeadlinesTopic);
  });

  bot.hears(labels("image"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "image_prompt";
    await ctx.reply(STRINGS[ctx.session.lang].askImagePrompt);
  });

  bot.hears(labels("plan"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "plan_niche";
    const brand = ctx.session.brand;
    if (brand.niche) {
      await producePlan(ctx, brand.niche);
      ctx.session.mode = null;
    } else {
      await ctx.reply(STRINGS[ctx.session.lang].askPlanNiche);
    }
  });

  bot.hears(labels("analyze"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "analyze_text";
    await ctx.reply(STRINGS[ctx.session.lang].askAnalyze);
  });

  bot.hears(labels("repurpose"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "repurpose_text";
    await ctx.reply(STRINGS[ctx.session.lang].askRepurpose);
  });

  bot.hears(labels("hashtags"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "hashtag_topic";
    await ctx.reply(STRINGS[ctx.session.lang].askHashtags);
  });

  bot.hears(labels("rewrite"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "rewrite_text";
    await ctx.reply(STRINGS[ctx.session.lang].askRewrite);
  });

  bot.hears(labels("caption"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "caption_photo";
    await ctx.reply(STRINGS[ctx.session.lang].askCaption);
  });

  bot.hears(labels("brand"), async (ctx) => {
    if (!(await ensureAccess(ctx))) return;
    ctx.session.mode = "brand_niche";
    await ctx.reply(STRINGS[ctx.session.lang].brandStep1);
  });

  bot.hears(labels("history"), async (ctx) => {
    if (!ctx.from) return;
    if (!(await ensureAccess(ctx))) return;
    const lang = ctx.session.lang;
    const items = await recentHistory(ctx.from.id, 10);
    if (items.length === 0) {
      await ctx.reply(STRINGS[lang].historyEmpty);
      return;
    }
    const locale = lang === "ru" ? "ru-RU" : "en-US";
    const lines = items.map((it, i) => {
      const d = new Date(it.created_at);
      const time = d.toLocaleString(locale, {
        dateStyle: "short",
        timeStyle: "short",
      });
      return `${i + 1}. [${time}] ${it.kind}\n   "${it.input.slice(0, 80)}${
        it.input.length > 80 ? "…" : ""
      }"`;
    });
    await ctx.reply(`${STRINGS[lang].historyTitle}\n\n${lines.join("\n\n")}`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;

    if (data === "lang_ru" || data === "lang_en") {
      const lang: Lang = data === "lang_ru" ? "ru" : "en";
      ctx.session.lang = lang;
      await saveLang(ctx.from.id, lang);
      await ctx.reply(STRINGS[lang].langSet);
      const ob = await loadOnboarding(ctx.from.id);
      if (!ob.captchaPassed) {
        await sendCaptcha(ctx, lang);
      } else {
        ctx.session.onboarded = true;
        await ctx.reply(STRINGS[lang].menuPick, { reply_markup: mainMenu(lang) });
      }
      return;
    }

    if (data.startsWith("cap_")) {
      const lang = ctx.session.lang;
      const picked = data.slice(4);
      const ob = await loadOnboarding(ctx.from.id);
      if (!ob.captchaTarget) {
        await sendCaptcha(ctx, lang);
        return;
      }
      if (picked !== ob.captchaTarget) {
        await ctx.reply(STRINGS[lang].captchaWrong);
        await sendCaptcha(ctx, lang);
        return;
      }
      await markCaptchaPassed(ctx.from.id);
      ctx.session.onboarded = true;
      await ctx.reply(STRINGS[lang].captchaOk);
      const status = await getUserStatus(ctx.from.id);
      const name = ctx.from.first_name ?? (lang === "ru" ? "друг" : "friend");
      await ctx.reply(
        STRINGS[lang].welcome(name, formatStatus(status, lang), ctx.from.id),
        { parse_mode: "Markdown", reply_markup: mainMenu(lang) },
      );
      return;
    }

    if (data.startsWith("buy_")) {
      const idx = Number(data.slice(4));
      const plan = STAR_PLANS[idx];
      if (!plan) return;
      try {
        await ctx.api.sendInvoice(
          ctx.from.id,
          `${BRAND} — ${plan.label}`,
          `Подписка ${BRAND} на ${plan.days} дн. Доступ ко всем функциям без лимитов.`,
          `plan_${idx}`,
          "XTR",
          [{ label: plan.label, amount: plan.stars }],
        );
      } catch (e) {
        logger.error({ err: (e as Error).message }, "sendInvoice failed");
        await ctx.reply(STRINGS[ctx.session.lang].payFail);
      }
      return;
    }

    const lang = ctx.session.lang;
    const s = STRINGS[lang];
    const last = ctx.session.lastPost;
    if (!last) {
      await ctx.reply(s.noLastPost);
      return;
    }
    if (!(await ensureAccess(ctx))) return;
    const userId = ctx.from.id;

    if (data === "post_regen") {
      await ctx.reply(s.workingRegen);
      const out = await compose(
        PROMPT_POST,
        `${brandContext(ctx.session.brand)}Тема: ${last.slice(0, 200)}\n\nПерепиши пост в другом стиле и с другим хуком.`,
        2000,
        { userId, kind: "post_regen" },
      );
      ctx.session.lastPost = out;
      await ctx.reply(out, { reply_markup: postFollowupKeyboard(lang) });
      await logGeneration(userId, "post_regen", last.slice(0, 200), out);
      return;
    }
    if (data === "post_stronger") {
      await ctx.reply(s.workingStronger);
      const out = await compose(
        PROMPT_POST,
        `${brandContext(ctx.session.brand)}Сделай этот пост ещё сильнее: жёстче хук, конкретнее польза, мощнее CTA.\n\nТекст:\n${last}`,
        2000,
        { userId, kind: "post_stronger" },
      );
      ctx.session.lastPost = out;
      await ctx.reply(out, { reply_markup: postFollowupKeyboard(lang) });
      await logGeneration(userId, "post_stronger", last.slice(0, 200), out);
      return;
    }
    if (data === "post_shorter") {
      await ctx.reply(s.workingShorter);
      const out = await compose(
        PROMPT_POST,
        `Сократи пост до 400–600 знаков, сохранив суть и силу:\n\n${last}`,
        1200,
        { userId, kind: "post_shorter" },
      );
      ctx.session.lastPost = out;
      await ctx.reply(out, { reply_markup: postFollowupKeyboard(lang) });
      await logGeneration(userId, "post_shorter", last.slice(0, 200), out);
      return;
    }
    if (data === "post_longer") {
      await ctx.reply(s.workingLonger);
      const out = await compose(
        PROMPT_POST,
        `Расширь пост до 1500–2000 знаков, добавив примеры, цифры и конкретику:\n\n${last}`,
        2500,
        { userId, kind: "post_longer" },
      );
      ctx.session.lastPost = out;
      await ctx.reply(out, { reply_markup: postFollowupKeyboard(lang) });
      await logGeneration(userId, "post_longer", last.slice(0, 200), out);
      return;
    }
    if (data === "post_image") {
      await ctx.reply(s.workingImage);
      try {
        const promptImg = await compose(PROMPT_IMG_PROMPT, last, 400, {
          userId,
          kind: "post_image_prompt",
        });
        const buf = await renderImage(promptImg, {
          userId,
          kind: "post_image",
        });
        await ctx.replyWithPhoto(new InputFile(buf, "post.png"), {
          caption: s.imageReady,
        });
        await logGeneration(userId, "post_image", last.slice(0, 200), promptImg);
      } catch (e) {
        await ctx.reply(s.imageFail((e as Error).message));
      }
      return;
    }
    if (data === "post_hashtags") {
      await ctx.reply(s.workingHashtags);
      const out = await compose(PROMPT_HASHTAGS, last, 800, {
        userId,
        kind: "post_hashtags",
      });
      await ctx.reply(out);
      await logGeneration(userId, "post_hashtags", last.slice(0, 200), out);
      return;
    }
    if (data === "post_repurpose") {
      await ctx.reply(s.workingRepurpose);
      const out = await compose(PROMPT_REPURPOSE, last, 3000, {
        userId,
        kind: "post_repurpose",
      });
      await ctx.reply(out);
      await logGeneration(userId, "post_repurpose", last.slice(0, 200), out);
      return;
    }
  });

  bot.on("message:photo", async (ctx) => {
    const lang = ctx.session.lang;
    const s = STRINGS[lang];
    if (ctx.session.mode !== "caption_photo") {
      await ctx.reply(s.needCaptionMode);
      return;
    }
    if (!(await ensureAccess(ctx))) return;
    await ctx.replyWithChatAction("typing");
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) throw new Error("photo missing");
      const file = await ctx.api.getFile(largest.file_id);
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
      const out = await describePhoto(
        url,
        PROMPT_CAPTION + "\n\n" + brandContext(ctx.session.brand),
        ctx.message.caption ??
          (lang === "ru"
            ? "Создай заголовок, подпись и хэштеги для этого изображения."
            : "Write a headline, caption and hashtags for this image."),
        { userId: ctx.from?.id, kind: "caption" },
      );
      await ctx.reply(
        out ||
          (lang === "ru"
            ? "Не получилось распознать изображение, попробуй другое фото."
            : "Could not recognize this image, try another photo."),
      );
      await logGeneration(ctx.from?.id, "caption", ctx.message.caption ?? "photo", out);
      if (ctx.from) await consumeQuota(ctx.from.id);
      ctx.session.mode = null;
    } catch (e) {
      await ctx.reply(s.photoFail((e as Error).message));
      ctx.session.mode = null;
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    await upsertUser(ctx);
    if (!ctx.session.onboarded) {
      await refreshSessionFromDb(ctx);
    }
    if (!ctx.session.onboarded) {
      const ob = ctx.from
        ? await loadOnboarding(ctx.from.id)
        : { lang: null, captchaPassed: false, captchaTarget: null };
      if (!ob.lang) {
        await startOnboarding(ctx);
      } else {
        await sendCaptcha(ctx, ob.lang);
      }
      return;
    }

    const lang = ctx.session.lang;
    const s = STRINGS[lang];
    const mode = ctx.session.mode;

    if (mode === "brand_niche") {
      ctx.session.brand.niche = text;
      ctx.session.mode = "brand_audience";
      await ctx.reply(s.brandStep2);
      return;
    }
    if (mode === "brand_audience") {
      ctx.session.brand.audience = text;
      ctx.session.mode = "brand_tone";
      await ctx.reply(s.brandStep3);
      return;
    }
    if (mode === "brand_tone") {
      ctx.session.brand.tone = text;
      ctx.session.mode = "brand_language";
      await ctx.reply(s.brandStep4);
      return;
    }
    if (mode === "brand_language") {
      ctx.session.brand.language = text;
      ctx.session.mode = null;
      if (ctx.from) await saveBrand(ctx.from.id, ctx.session.brand);
      await ctx.reply(s.brandSaved(brandContext(ctx.session.brand)), {
        reply_markup: mainMenu(lang),
      });
      return;
    }

    if (
      mode === "schedule_channel" ||
      mode === "schedule_text" ||
      mode === "schedule_when"
    ) {
      if (!(await ensureAccess(ctx))) return;
      if (mode === "schedule_channel") {
        ctx.session.schedule.channel = text;
        ctx.session.mode = "schedule_text";
        await ctx.reply(s.askScheduleText);
        return;
      }
      if (mode === "schedule_text") {
        ctx.session.schedule.text = text;
        ctx.session.mode = "schedule_when";
        await ctx.reply(s.askScheduleWhen);
        return;
      }
      if (mode === "schedule_when") {
        const when = parseWhen(text);
        if (!when || when.getTime() <= Date.now()) {
          await ctx.reply(s.scheduleBadDate);
          return;
        }
        if (!ctx.from || !ctx.session.schedule.channel || !ctx.session.schedule.text) {
          ctx.session.mode = null;
          return;
        }
        const id = await createScheduledPost(
          ctx.from.id,
          ctx.session.schedule.channel,
          ctx.session.schedule.text,
          when,
        );
        ctx.session.mode = null;
        ctx.session.schedule = {};
        await ctx.reply(
          s.scheduleSaved(
            when.toISOString().replace("T", " ").slice(0, 16),
            id,
          ),
          { reply_markup: mainMenu(lang) },
        );
        return;
      }
    }

    if (mode) {
      if (!(await ensureAccess(ctx))) return;
    }

    const userId = ctx.from?.id;

    if (mode === "post_topic") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(
        PROMPT_POST,
        `${brandContext(ctx.session.brand)}Тема: ${text}`,
        2000,
        { userId, kind: "post" },
      );
      ctx.session.lastPost = out;
      ctx.session.history = [
        { role: "user", content: text },
        { role: "assistant", content: out },
      ];
      ctx.session.mode = "post_followup";
      await ctx.reply(out, { reply_markup: postFollowupKeyboard(lang) });
      await ctx.reply(s.postFollowupHint);
      await logGeneration(userId, "post", text, out);
      if (userId) await consumeQuota(userId);
      return;
    }

    if (mode === "post_followup") {
      await ctx.replyWithChatAction("typing");
      const out = await composeWithHistory(
        PROMPT_POST + "\n\n" + brandContext(ctx.session.brand),
        ctx.session.history,
        `Внеси правку и перепиши пост: ${text}`,
        2000,
        { userId, kind: "post_edit" },
      );
      ctx.session.history.push({ role: "user", content: text });
      ctx.session.history.push({ role: "assistant", content: out });
      ctx.session.lastPost = out;
      await ctx.reply(out, { reply_markup: postFollowupKeyboard(lang) });
      await logGeneration(userId, "post_edit", text, out);
      if (userId) await consumeQuota(userId);
      return;
    }

    if (mode === "idea_niche") {
      await produceIdeas(ctx, text);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "hook_topic") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(
        PROMPT_HOOKS,
        `${brandContext(ctx.session.brand)}Тема: ${text}`,
        1500,
        { userId, kind: "hooks" },
      );
      await ctx.reply(out, { reply_markup: mainMenu(lang) });
      await logGeneration(userId, "hooks", text, out);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "headline_topic") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(
        PROMPT_HEADLINES,
        `${brandContext(ctx.session.brand)}Тема: ${text}`,
        1200,
        { userId, kind: "headlines" },
      );
      await ctx.reply(out, { reply_markup: mainMenu(lang) });
      await logGeneration(userId, "headlines", text, out);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "image_prompt") {
      await ctx.reply(s.workingGenImage);
      try {
        const englishPrompt = await compose(PROMPT_IMG_TRANSLATE, text, 400, {
          userId,
          kind: "image_prompt",
        });
        const buf = await renderImage(englishPrompt, {
          userId,
          kind: "image",
        });
        await ctx.replyWithPhoto(new InputFile(buf, "image.png"), {
          caption: s.imageReady,
          reply_markup: mainMenu(lang),
        });
        await logGeneration(userId, "image", text, englishPrompt);
        if (userId) await consumeQuota(userId);
      } catch (e) {
        await ctx.reply(s.imageFail((e as Error).message));
      }
      ctx.session.mode = null;
      return;
    }

    if (mode === "plan_niche") {
      await producePlan(ctx, text);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "analyze_text") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(PROMPT_ANALYZE, text, 2500, {
        userId,
        kind: "analyze",
      });
      await ctx.reply(out, { reply_markup: mainMenu(lang) });
      await logGeneration(userId, "analyze", text, out);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "repurpose_text") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(PROMPT_REPURPOSE, text, 3000, {
        userId,
        kind: "repurpose",
      });
      await ctx.reply(out, { reply_markup: mainMenu(lang) });
      await logGeneration(userId, "repurpose", text, out);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "hashtag_topic") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(
        PROMPT_HASHTAGS,
        `${brandContext(ctx.session.brand)}Тема: ${text}`,
        800,
        { userId, kind: "hashtags" },
      );
      await ctx.reply(out, { reply_markup: mainMenu(lang) });
      await logGeneration(userId, "hashtags", text, out);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    if (mode === "rewrite_text") {
      await ctx.replyWithChatAction("typing");
      const out = await compose(
        PROMPT_REWRITE,
        `${brandContext(ctx.session.brand)}Текст:\n${text}`,
        2000,
        { userId, kind: "rewrite" },
      );
      await ctx.reply(out, { reply_markup: mainMenu(lang) });
      await logGeneration(userId, "rewrite", text, out);
      if (userId) await consumeQuota(userId);
      ctx.session.mode = null;
      return;
    }

    await ctx.reply(s.fallback, { reply_markup: mainMenu(lang) });
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      logger.error({ err: e.description }, "Grammy error");
    } else if (e instanceof HttpError) {
      logger.error({ err: e.message }, "HTTP error");
    } else {
      logger.error({ err: (e as Error).message }, "Bot error");
    }
  });

  async function produceIdeas(ctx: BotContext, niche: string): Promise<void> {
    await ctx.replyWithChatAction("typing");
    const out = await compose(
      PROMPT_IDEAS,
      `${brandContext(ctx.session.brand)}Ниша: ${niche}`,
      2500,
      { userId: ctx.from?.id, kind: "ideas" },
    );
    await ctx.reply(out, { reply_markup: mainMenu(ctx.session.lang) });
    await logGeneration(ctx.from?.id, "ideas", niche, out);
  }

  async function producePlan(ctx: BotContext, niche: string): Promise<void> {
    await ctx.replyWithChatAction("typing");
    const out = await compose(
      PROMPT_PLAN,
      `${brandContext(ctx.session.brand)}Ниша: ${niche}`,
      2500,
      { userId: ctx.from?.id, kind: "plan" },
    );
    await ctx.reply(out, { reply_markup: mainMenu(ctx.session.lang) });
    await logGeneration(ctx.from?.id, "plan", niche, out);
  }

  startScheduler(bot);

  void bot.start({
    onStart: (info) =>
      logger.info({ username: info.username, brand: BRAND }, "bot started"),
  });
}
