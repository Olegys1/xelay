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
    const { text } = req.body;

    const completion =
      await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
     content:
  "Translate the following text into Ukrainian. Preserve formatting exactly. Return only the translated text without explanations.",
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