export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requiredText(value, label, maxLength = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AppError(400, `${label} must contain 1–${maxLength} characters.`);
  }
  return value.trim();
}

export function loadConfig(env = process.env) {
  if (!env.GROQ_API_KEY?.trim()) throw new Error('Set GROQ_API_KEY in your local .env.');
  if (!env.OWNER_ACCESS_KEY || env.OWNER_ACCESS_KEY.trim().length < 32 || env.OWNER_ACCESS_KEY.length > 512) {
    throw new Error('Set OWNER_ACCESS_KEY to a random secret of 32–512 characters in your local .env.');
  }
  let appUrl;
  try {
    appUrl = new URL(env.APP_URL || 'http://localhost:3000');
  } catch {
    throw new Error('APP_URL must be a valid origin, such as http://localhost:3000.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname);
  if (appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash ||
      (appUrl.protocol !== 'https:' && !(loopback && appUrl.protocol === 'http:')) ||
      (env.NODE_ENV === 'production' && appUrl.protocol !== 'https:')) {
    throw new Error('APP_URL must be an HTTPS origin, or HTTP localhost for development.');
  }
  const port = Number(env.PORT || appUrl.port || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  return {
    appUrl,
    port,
    ownerKey: env.OWNER_ACCESS_KEY,
    groqKey: env.GROQ_API_KEY.trim(),
    groqModel: env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b',
  };
}
