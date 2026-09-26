import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  uk: "Ukrainian",
  pl: "Polish",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  tr: "Turkish",
  hi: "Hindi",
  ar: "Arabic",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const {
      text,
      targetLanguage,
    } = req.body;

    console.log("TRANSLATION REQUEST:", {
      targetLanguage,
      languageName: LANGUAGE_NAMES[targetLanguage],
    });

    const languageName = LANGUAGE_NAMES[targetLanguage];

    if (!languageName) {
      return res.status(400).json({
        error: "Unsupported language",
      });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are a professional translation engine.

Translate the text into ${languageName}.

IMPORTANT:
The target language is ${languageName}.
You MUST translate into ${languageName}.
Do NOT translate into another language.

Return ONLY the translated text.

Rules:
- Preserve the original meaning.
- Preserve formatting.
- Preserve emojis.
- Preserve markdown.
- Do not explain anything.
- Do not add quotation marks.
- Do not change URLs, usernames or hashtags.
`,
        },
        {
          role: "user",
          content: text,
        },
      ],
    });

    const translation =
      completion.choices[0].message.content?.trim() ?? text;

    return res.status(200).json({
      translation,
    });

  } catch (error) {
    console.error("TRANSLATION ERROR:", error);

    return res.status(500).json({
      error: "Translation failed",
    });
  }
}