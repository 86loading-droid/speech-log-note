/* ============================================================
   발화 기록 노트 — 발음 모델(음성 복제) 중계 Worker
   Cloudflare Workers 무료 요금제에서 동작합니다.

   역할: API 키를 브라우저에 노출하지 않기 위한 중계(proxy)입니다.
        음성과 텍스트를 저장하지 않고, 기록도 남기지 않습니다.
        KV·R2·D1 등 저장소를 일절 사용하지 않습니다.

   설정할 값 (wrangler secret / 대시보드 Variables)
     XI_KEY        : ElevenLabs API 키 (Secret)
     APP_TOKEN     : 앱이 보낼 공유 암호. 아무 긴 문자열 (Secret)
     ALLOW_ORIGIN  : 앱 주소. 예) https://86loading-droid.github.io
     MODEL_ID      : (선택) 기본 eleven_multilingual_v2
     MAX_CHARS     : (선택) 1회 합성 최대 글자 수. 기본 300
     ZERO_LOG      : (선택) "1"이면 ElevenLabs 서버 로그 비활성 요청
                     (기업 요금제 전용 기능이므로 일반 요금제에서는 비워 두십시오)
   ============================================================ */

const API = "https://api.elevenlabs.io/v1";

function cors(env, extra) {
  const h = {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-App-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
  return Object.assign(h, extra || {});
}

function json(env, obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: cors(env, { "Content-Type": "application/json; charset=utf-8" })
  });
}

function authed(req, env) {
  if (!env.APP_TOKEN) return true;              // 토큰 미설정 시 통과(권장하지 않음)
  return req.headers.get("X-App-Token") === env.APP_TOKEN;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (path === "/health") {
      return json(env, {
        ok: true,
        provider: "elevenlabs",
        keyed: !!env.XI_KEY,
        model: env.MODEL_ID || "eleven_multilingual_v2",
        maxChars: +(env.MAX_CHARS || 300)
      });
    }

    if (!authed(req, env)) return json(env, { error: "인증 실패: 공유 암호가 맞지 않습니다." }, 401);
    if (!env.XI_KEY) return json(env, { error: "서버에 API 키가 설정되지 않았습니다." }, 500);

    /* ---- 목소리 등록 (Instant Voice Clone) ---- */
    if (path === "/voice" && req.method === "POST") {
      let inForm;
      try { inForm = await req.formData(); }
      catch (e) { return json(env, { error: "업로드 형식이 올바르지 않습니다." }, 400); }

      const files = inForm.getAll("file").filter(Boolean);
      if (!files.length) return json(env, { error: "참조 음성 파일이 없습니다." }, 400);

      const name = String(inForm.get("name") || "student").slice(0, 40);
      const out = new FormData();
      out.append("name", name);
      files.slice(0, 10).forEach((f, i) => out.append("files", f, "ref" + i + ".webm"));
      out.append("remove_background_noise", "true");

      const r = await fetch(API + "/voices/add", {
        method: "POST",
        headers: { "xi-api-key": env.XI_KEY },
        body: out
      });
      const txt = await r.text();
      if (!r.ok) return json(env, { error: "등록 실패", status: r.status, detail: txt.slice(0, 400) }, 502);
      let data = {};
      try { data = JSON.parse(txt); } catch (e) {}
      return json(env, { voiceId: data.voice_id || "", needsVerify: !!data.requires_verification });
    }

    /* ---- 목소리 삭제 ---- */
    if (path === "/voice" && req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json(env, { error: "삭제할 목소리 번호가 없습니다." }, 400);
      const r = await fetch(API + "/voices/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: { "xi-api-key": env.XI_KEY }
      });
      return json(env, { ok: r.ok, status: r.status });
    }

    /* ---- 합성 ---- */
    if (path === "/speak" && req.method === "POST") {
      let body;
      try { body = await req.json(); }
      catch (e) { return json(env, { error: "요청 형식이 올바르지 않습니다." }, 400); }

      const voiceId = String(body.voiceId || "").trim();
      const text = String(body.text || "").trim();
      const max = +(env.MAX_CHARS || 300);
      if (!voiceId) return json(env, { error: "등록된 목소리가 없습니다." }, 400);
      if (!text) return json(env, { error: "읽을 내용이 없습니다." }, 400);
      if (text.length > max) return json(env, { error: "한 번에 " + max + "자까지만 읽어 줍니다." }, 413);

      const qs = new URLSearchParams({ output_format: "mp3_44100_64" });
      if (env.ZERO_LOG === "1") qs.set("enable_logging", "false");

      const r = await fetch(API + "/text-to-speech/" + encodeURIComponent(voiceId) + "?" + qs, {
        method: "POST",
        headers: { "xi-api-key": env.XI_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          model_id: env.MODEL_ID || "eleven_multilingual_v2",
          language_code: "ko",
          voice_settings: { stability: 0.6, similarity_boost: 0.85, speed: 0.9 }
        })
      });

      if (!r.ok) {
        const t = await r.text();
        return json(env, { error: "합성 실패", status: r.status, detail: t.slice(0, 400) }, 502);
      }
      return new Response(r.body, {
        status: 200,
        headers: cors(env, { "Content-Type": "audio/mpeg" })
      });
    }

    return json(env, { error: "알 수 없는 요청입니다." }, 404);
  }
};
