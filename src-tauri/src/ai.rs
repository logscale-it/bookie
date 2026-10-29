//! AI receipt extraction: builds one provider request for an uploaded
//! receipt (PDF or image) and pulls the model's text out of the response.
//! Pure; `ai_extract_invoice` in lib.rs does the keyring read and HTTP.
//!
//! Three request shapes cover all providers: Anthropic Messages, Gemini
//! generateContent, and OpenAI-compatible chat completions (OpenAI, Mistral,
//! Ollama via its `/v1` endpoint).

use base64::Engine;
use serde_json::{json, Value};

pub const PROMPT: &str = "Lies diese Eingangsrechnung aus. Antworte ausschließlich mit einem \
JSON-Objekt ohne weiteren Text: {\"supplier_name\": string, \"invoice_number\": string, \
\"invoice_date\": \"YYYY-MM-DD\", \"net_amount\": number, \"tax_amount\": number, \
\"currency\": string}. net_amount ist die Nettosumme, tax_amount die gesamte Umsatzsteuer. \
Unbekannte Felder auf null setzen.";

/// Returned when an OpenAI-compatible provider other than OpenAI gets a PDF.
pub const PDF_UNSUPPORTED: &str =
    "Dieser Anbieter kann keine PDFs lesen. Bitte den Beleg als Bild (PNG/JPG) hochladen.";

pub struct AiRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

fn trim_base(base_url: &str) -> &str {
    base_url.trim_end_matches('/')
}

pub fn build_request(
    provider: &str,
    model: &str,
    base_url: &str,
    mime: &str,
    bytes: &[u8],
    key: Option<&str>,
) -> Result<AiRequest, String> {
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let is_pdf = mime == "application/pdf";
    let key = key.unwrap_or_default().to_string();
    match provider {
        "anthropic" => {
            let kind = if is_pdf { "document" } else { "image" };
            Ok(AiRequest {
                url: "https://api.anthropic.com/v1/messages".into(),
                headers: vec![
                    ("x-api-key", key),
                    ("anthropic-version", "2023-06-01".into()),
                ],
                body: json!({
                    "model": model,
                    "max_tokens": 1024,
                    "messages": [{"role": "user", "content": [
                        {"type": kind, "source": {"type": "base64", "media_type": mime, "data": data}},
                        {"type": "text", "text": PROMPT}
                    ]}]
                }),
            })
        }
        "gemini" => Ok(AiRequest {
            url: format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
            ),
            headers: vec![("x-goog-api-key", key)],
            body: json!({
                "contents": [{"parts": [
                    {"inline_data": {"mime_type": mime, "data": data}},
                    {"text": PROMPT}
                ]}]
            }),
        }),
        "openai" | "mistral" | "ollama" => {
            let file_part = if !is_pdf {
                json!({"type": "image_url", "image_url": {"url": format!("data:{mime};base64,{data}")}})
            } else if provider == "openai" {
                json!({"type": "file", "file": {"filename": "beleg.pdf", "file_data": format!("data:{mime};base64,{data}")}})
            } else {
                // ponytail: Mistral/Ollama chat has no confirmed inline-PDF input;
                // render page 1 to an image in the frontend if PDFs are needed there.
                return Err(PDF_UNSUPPORTED.into());
            };
            let mut headers = vec![];
            if !key.is_empty() {
                headers.push(("authorization", format!("Bearer {key}")));
            }
            Ok(AiRequest {
                url: format!("{}/chat/completions", trim_base(base_url)),
                headers,
                body: json!({
                    "model": model,
                    "messages": [{"role": "user", "content": [
                        file_part,
                        {"type": "text", "text": PROMPT}
                    ]}]
                }),
            })
        }
        other => Err(format!("Unbekannter KI-Anbieter: {other}")),
    }
}

/// The model's answer text, or `None` when the response has an unexpected shape.
pub fn response_text(provider: &str, v: &Value) -> Option<String> {
    let text = match provider {
        "anthropic" => v["content"][0]["text"].as_str(),
        "gemini" => v["candidates"][0]["content"]["parts"][0]["text"].as_str(),
        _ => v["choices"][0]["message"]["content"].as_str(),
    };
    text.map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_pdf_uses_document_block() {
        let r = build_request("anthropic", "m", "", "application/pdf", b"x", Some("k")).unwrap();
        assert_eq!(r.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "document");
        assert_eq!(
            r.body["messages"][0]["content"][0]["source"]["data"],
            "eA=="
        );
        assert!(r.headers.contains(&("x-api-key", "k".into())));
    }

    #[test]
    fn gemini_puts_model_in_url() {
        let r = build_request("gemini", "flash", "", "image/png", b"x", Some("k")).unwrap();
        assert!(r.url.ends_with("/models/flash:generateContent"));
        assert_eq!(
            r.body["contents"][0]["parts"][0]["inline_data"]["mime_type"],
            "image/png"
        );
    }

    #[test]
    fn openai_compatible_shapes() {
        let r = build_request(
            "openai",
            "m",
            "https://api.openai.com/v1/",
            "application/pdf",
            b"x",
            Some("k"),
        )
        .unwrap();
        assert_eq!(r.url, "https://api.openai.com/v1/chat/completions");
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "file");
        assert!(r.headers.contains(&("authorization", "Bearer k".into())));

        let r = build_request(
            "ollama",
            "m",
            "http://localhost:11434/v1",
            "image/jpeg",
            b"x",
            None,
        )
        .unwrap();
        assert_eq!(r.body["messages"][0]["content"][0]["type"], "image_url");
        assert!(r.headers.is_empty());

        assert_eq!(
            build_request(
                "mistral",
                "m",
                "https://api.mistral.ai/v1",
                "application/pdf",
                b"x",
                Some("k")
            )
            .err()
            .as_deref(),
            Some(PDF_UNSUPPORTED)
        );
        assert!(build_request("nope", "m", "", "image/png", b"x", None).is_err());
    }

    #[test]
    fn extracts_text_per_provider() {
        let a = json!({"content": [{"type": "text", "text": "A"}]});
        let g = json!({"candidates": [{"content": {"parts": [{"text": "G"}]}}]});
        let o = json!({"choices": [{"message": {"content": "O"}}]});
        assert_eq!(response_text("anthropic", &a).as_deref(), Some("A"));
        assert_eq!(response_text("gemini", &g).as_deref(), Some("G"));
        assert_eq!(response_text("mistral", &o).as_deref(), Some("O"));
        assert_eq!(response_text("openai", &a), None);
    }
}
