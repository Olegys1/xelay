import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
    const {
      text,
      targetLanguage,
      questionId,
      answerId,
    } = req.body;



    if (questionId) {
      const { data: cached } = await supabase
        .from("question_translations")
        .select("translated_text")
        .eq("question_id", questionId)
        .eq("language", targetLanguage)
        .maybeSingle();

      if (cached) {
        return res.status(200).json({
          translation: cached.translated_text,
        });
      }
    }


    if (answerId) {
      const { data: cached } = await supabase
        .from("answer_translations")
        .select("translated_text")
        .eq("answer_id", answerId)
        .eq("language", targetLanguage)
        .maybeSingle();

      if (cached) {
        return res.status(200).json({
          translation: cached.translated_text,
        });
      }
    }


    const completion = await client.chat.completions.create({
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
      completion.choices[0].message.content ?? text;


    if (questionId) {
      await supabase
        .from("question_translations")
        .insert({
          question_id: questionId,
          language: targetLanguage,
          translated_text: translation,
        });
    }



    if (answerId) {
      await supabase
        .from("answer_translations")
        .insert({
          answer_id: answerId,
          language: targetLanguage,
          translated_text: translation,
        });
    }

    return res.status(200).json({
      translation,
    });
  } catch (e) {
    console.error(e);

    return res.status(500).json({
      error: "Translation failed",
    });
  }
}