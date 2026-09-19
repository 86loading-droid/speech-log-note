/* ============================================================
   발화 기록 노트 — 목소리 복제 중계 Worker
   Cloudflare Workers 무료 요금제에서 동작합니다.

   하는 일: 학생 목소리를 복제해 임의의 한국어 문장을 읽어 줍니다.
           API 키를 브라우저에 노출하지 않기 위한 중계(proxy)이며,
           음성과 문장을 저장하지 않고 기록도 남기지 않습니다.
           KV·R2·D1 등 저장소를 일절 사용하지 않습니다.

   쓰는 모델: fal.ai 의 Qwen3-TTS (한국어 지원, 사용한 만큼 과금)
     - 목소리 등록  fal-ai/qwen-3-tts/clone-voice/0.6b   약 $0.0008/분
     - 문장 읽기    fal-ai/qwen-3-tts/text-to-speech/0.6b 약 $0.07/1000자

   설정할 값 (wrangler secret / 대시보드 Variables)
     FAL_KEY       : fal.ai API 키 (Secret)
     APP_TOKEN     : 앱이 보낼 공유 암호. 아무 긴 문자열 (Secret)
     ALLOW_ORIGIN  : 앱 주소. 예) https://86loading-droid.github.io
     SIZE          : (선택) 모델 크기 "0.6b"(기본) 또는 "1.7b"
     MAX_CHARS     : (선택) 1회 최대 글자 수. 기본 200
   ============================================================ */

const BASE = "https://fal.run/fal-ai/qwen-3-tts";

function cors(env, extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-App-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  }, extra || {});
}
function json(env, obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: cors(env, { "Content-Type": "application/json; charset=utf-8" })
  });
}
function authed(req, env) {
  if (!env.APP_TOKEN) return true;
  return req.headers.get("X-App-Token") === env.APP_TOKEN;
}
function falHeaders(env) {
  return { "Authorization": "Key " + env.FAL_KEY, "Content-Type": "application/json" };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const size = (env.SIZE || "0.6b");

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (path === "/health") {
      return json(env, {
        ok: true,
        provider: "fal/qwen3-tts",
        keyed: !!env.FAL_KEY,
        size: size,
        maxChars: +(env.MAX_CHARS || 200)
      });
    }

    if (!authed(req, env)) return json(env, { error: "인증 실패: 공유 암호가 맞지 않습니다." }, 401);
    if (!env.FAL_KEY) return json(env, { error: "서버에 API 키가 설정되지 않았습니다." }, 500);

    /* ---- 목소리 등록: 참조 음성 → 목소리 파일 주소 ---- */
    if (path === "/voice" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json(env, { error: "요청 형식이 올바르지 않습니다." }, 400); }

      const audio = String(body.audio || "");
      if (!audio.startsWith("data:")) return json(env, { error: "참조 음성이 없습니다." }, 400);

      const payload = { audio_url: audio };
      if (body.refText) payload.reference_text = String(body.refText).slice(0, 300);

      const r = await fetch(BASE + "/clone-voice/" + size, {
        method: "POST", headers: falHeaders(env), body: JSON.stringify(payload)
      });
      const txt = await r.text();
      if (!r.ok) return json(env, { error: "등록 실패", status: r.status, detail: txt.slice(0, 400) }, 502);

      let d = {};
      try { d = JSON.parse(txt); } catch (e) {}
      const vurl = d && d.speaker_embedding && d.speaker_embedding.url;
      if (!vurl) return json(env, { error: "목소리 파일을 받지 못했습니다.", detail: txt.slice(0, 300) }, 502);
      return json(env, { voiceUrl: vurl });
    }

    /* ---- 문장 읽기: 목소리 + 글 → 소리 ---- */
    if (path === "/speak" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json(env, { error: "요청 형식이 올바르지 않습니다." }, 400); }

      const voiceUrl = String(body.voiceUrl || "").trim();
      const text = String(body.text || "").trim();
      const max = +(env.MAX_CHARS || 200);
      if (!voiceUrl) return json(env, { error: "등록된 목소리가 없습니다." }, 400);
      if (!text) return json(env, { error: "읽을 내용이 없습니다." }, 400);
      if (text.length > max) return json(env, { error: "한 번에 " + max + "자까지만 읽어 줍니다." }, 413);

      const r = await fetch(BASE + "/text-to-speech/" + size, {
        method: "POST", headers: falHeaders(env),
        body: JSON.stringify({
          text: text,
          language: "Korean",
          speaker_voice_embedding_file_url: voiceUrl,
          temperature: 0.7
        })
      });
      const txt = await r.text();
      if (!r.ok) return json(env, { error: "읽지 못했습니다.", status: r.status, detail: txt.slice(0, 400) }, 502);

      let d = {};
      try { d = JSON.parse(txt); } catch (e) {}
      const aurl = d && d.audio && d.audio.url;
      if (!aurl) return json(env, { error: "소리를 받지 못했습니다.", detail: txt.slice(0, 300) }, 502);

      /* 소리를 그대로 흘려보낸다. 저장하지 않는다. */
      const a = await fetch(aurl);
      if (!a.ok) return json(env, { error: "소리를 내려받지 못했습니다.", status: a.status }, 502);
      return new Response(a.body, {
        status: 200,
        headers: cors(env, { "Content-Type": a.headers.get("Content-Type") || "audio/mpeg" })
      });
    }

    return json(env, { error: "알 수 없는 요청입니다." }, 404);
  }
};
