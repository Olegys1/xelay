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

    const completion =
      await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
     content: `
Translate the following text into the language specified by this locale: ${targetLanguage}.

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