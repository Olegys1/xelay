import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const { text, targetLanguage } = req.body;
    console.log("Target language:", targetLanguage);
    console.log("TARGET LANGUAGE:", targetLanguage);

    const completion =
      await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
     content: `
You are a translation engine.

Translate the user's text into the language code: ${targetLanguage}.

Rules:
- Return ONLY the translation.
- Preserve formatting.
- Preserve emojis.
- Preserve markdown.
- Do not explain anything.
- Do not add quotation marks.
- Do not change URLs, usernames or hashtags..

Rules:
- Preserve formatting.
- Preserve emojis.
- Preserve markdown.
- Return ONLY the translated text.
`,
          },
          {
            role: "user",
            content: text,
          },
        ],
      });

    res.status(200).json({
      translation:
        completion.choices[0].message.content,
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: "Translation failed",
    });
  }
}