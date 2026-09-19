/* ============================================================
   발화 기록 노트 — 목소리 복제 중계 Worker
   Cloudflare Workers 무료 요금제에서 동작합니다.

   하는 일: 학생 목소리를 복제해 한국어 문장을 읽어 줍니다.
           토큰을 브라우저에 노출하지 않기 위한 중계(proxy)이며,
           음성과 글을 저장하지 않고 기록도 남기지 않습니다.
           KV·R2·D1 등 저장소를 일절 사용하지 않습니다.

   두 가지 뒤끝(backend)을 지원합니다.

   1) BACKEND="hf"  (기본, 무료)
      교수님 계정의 허깅페이스 Space 에 올린 XTTS-v2 를 씁니다.
      무료 계정 ZeroGPU 하루 5분. 짧은 문장 60~150회 수준.
        SPACE     : 예) 86loading-droid-speech-voice.hf.space  또는  계정/이름
        HF_TOKEN  : 허깅페이스 읽기 토큰 (Private Space 면 필수)

   2) BACKEND="fal" (유료, 쓴 만큼)
      fal.ai 의 Qwen3-TTS 를 씁니다. 등록 약 $0.0008/분, 읽기 약 $0.07/1000자.
        FAL_KEY   : fal.ai API 키
        SIZE      : "0.6b"(기본) 또는 "1.7b"

   공통
     APP_TOKEN    : 앱이 보낼 공유 암호 (Secret)
     ALLOW_ORIGIN : 앱 주소. 예) https://86loading-droid.github.io
     MAX_CHARS    : 1회 최대 글자 수. 기본 200
   ============================================================ */

const FAL = "https://fal.run/fal-ai/qwen-3-tts";

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
function backendOf(env) { return (env.BACKEND || "hf").toLowerCase(); }
function spaceHost(env) {
  let s = String(env.SPACE || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!s) return "";
  if (s.indexOf(".hf.space") < 0 && s.indexOf("/") > 0) {
    s = s.replace("/", "-").toLowerCase() + ".hf.space";   // 계정/이름 → 주소
  }
  return "https://" + s;
}
function hfHeaders(env, extra) {
  const h = Object.assign({}, extra || {});
  if (env.HF_TOKEN) h["Authorization"] = "Bearer " + env.HF_TOKEN;
  return h;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const be = backendOf(env);
    const max = +(env.MAX_CHARS || 200);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    if (path === "/health") {
      return json(env, {
        ok: true,
        provider: be === "fal" ? "fal/qwen3-tts" : "hf/xtts-v2",
        backend: be,
        keyed: be === "fal" ? !!env.FAL_KEY : !!spaceHost(env),
        maxChars: max,
        free: be !== "fal"
      });
    }

    if (!authed(req, env)) return json(env, { error: "인증 실패: 공유 암호가 맞지 않습니다." }, 401);

    /* ================= 허깅페이스 Space (무료) ================= */
    if (be !== "fal") {
      const host = spaceHost(env);
      if (!host) return json(env, { error: "서버에 Space 주소가 설정되지 않았습니다." }, 500);

      /* 참조 음성 올리기 → 서버 안 경로를 목소리로 쓴다 */
      if (path === "/voice" && req.method === "POST") {
        let form;
        try { form = await req.formData(); }
        catch (e) { return json(env, { error: "업로드 형식이 올바르지 않습니다." }, 400); }
        const file = form.get("file");
        if (!file) return json(env, { error: "참조 음성이 없습니다." }, 400);

        const out = new FormData();
        out.append("files", file, "ref.webm");
        const r = await fetch(host + "/gradio_api/upload", {
          method: "POST", headers: hfHeaders(env), body: out
        });
        const txt = await r.text();
        if (!r.ok) return json(env, { error: "등록 실패", status: r.status, detail: txt.slice(0, 300) }, 502);
        let arr = [];
        try { arr = JSON.parse(txt); } catch (e) {}
        const p = Array.isArray(arr) ? arr[0] : "";
        if (!p) return json(env, { error: "올린 파일 경로를 받지 못했습니다.", detail: txt.slice(0, 200) }, 502);
        return json(env, { voiceUrl: p });
      }

      /* 읽기 */
      if (path === "/speak" && req.method === "POST") {
        let body;
        try { body = await req.json(); } catch (e) { return json(env, { error: "요청 형식이 올바르지 않습니다." }, 400); }
        const voiceUrl = String(body.voiceUrl || "").trim();
        const text = String(body.text || "").trim();
        if (!voiceUrl) return json(env, { error: "등록된 목소리가 없습니다." }, 400);
        if (!text) return json(env, { error: "읽을 내용이 없습니다." }, 400);
        if (text.length > max) return json(env, { error: "한 번에 " + max + "자까지만 읽어 줍니다." }, 413);

        const payload = {
          data: [
            { path: voiceUrl, meta: { _type: "gradio.FileData" } },
            text
          ]
        };
        const start = await fetch(host + "/gradio_api/call/speak", {
          method: "POST",
          headers: hfHeaders(env, { "Content-Type": "application/json" }),
          body: JSON.stringify(payload)
        });
        const st = await start.text();
        if (!start.ok) return json(env, { error: "요청 실패", status: start.status, detail: st.slice(0, 300) }, 502);
        let ev = "";
        try { ev = (JSON.parse(st) || {}).event_id || ""; } catch (e) {}
        if (!ev) return json(env, { error: "요청 번호를 받지 못했습니다.", detail: st.slice(0, 200) }, 502);

        const res = await fetch(host + "/gradio_api/call/speak/" + ev, { headers: hfHeaders(env) });
        const body2 = await res.text();
        if (!res.ok) return json(env, { error: "결과를 받지 못했습니다.", status: res.status }, 502);
        if (body2.indexOf("event: error") >= 0) {
          return json(env, { error: "Space 에서 오류가 났습니다.", detail: body2.slice(-300) }, 502);
        }
        /* SSE 에서 마지막 data 줄을 꺼낸다 */
        const lines = body2.split("\n").filter(function (l) { return l.indexOf("data:") === 0; });
        const last = lines.length ? lines[lines.length - 1].slice(5).trim() : "";
        let audioUrl = "";
        try {
          const d = JSON.parse(last);
          const f = Array.isArray(d) ? d[0] : d;
          audioUrl = (f && (f.url || f.path)) || "";
          if (audioUrl && audioUrl.indexOf("http") !== 0) {
            audioUrl = host + "/gradio_api/file=" + audioUrl;
          }
        } catch (e) {}
        if (!audioUrl) return json(env, { error: "소리 주소를 찾지 못했습니다.", detail: last.slice(0, 200) }, 502);

        const a = await fetch(audioUrl, { headers: hfHeaders(env) });
        if (!a.ok) return json(env, { error: "소리를 내려받지 못했습니다.", status: a.status }, 502);
        return new Response(a.body, {
          status: 200,
          headers: cors(env, { "Content-Type": a.headers.get("Content-Type") || "audio/wav" })
        });
      }

      return json(env, { error: "알 수 없는 요청입니다." }, 404);
    }

    /* ================= fal.ai (유료) ================= */
    if (!env.FAL_KEY) return json(env, { error: "서버에 API 키가 설정되지 않았습니다." }, 500);
    const size = (env.SIZE || "0.6b");
    const falH = { "Authorization": "Key " + env.FAL_KEY, "Content-Type": "application/json" };

    if (path === "/voice" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json(env, { error: "요청 형식이 올바르지 않습니다." }, 400); }
      const audio = String(body.audio || "");
      if (!audio.startsWith("data:")) return json(env, { error: "참조 음성이 없습니다." }, 400);
      const r = await fetch(FAL + "/clone-voice/" + size, {
        method: "POST", headers: falH, body: JSON.stringify({ audio_url: audio })
      });
      const txt = await r.text();
      if (!r.ok) return json(env, { error: "등록 실패", status: r.status, detail: txt.slice(0, 300) }, 502);
      let d = {};
      try { d = JSON.parse(txt); } catch (e) {}
      const v = d && d.speaker_embedding && d.speaker_embedding.url;
      if (!v) return json(env, { error: "목소리 파일을 받지 못했습니다." }, 502);
      return json(env, { voiceUrl: v });
    }

    if (path === "/speak" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (e) { return json(env, { error: "요청 형식이 올바르지 않습니다." }, 400); }
      const voiceUrl = String(body.voiceUrl || "").trim();
      const text = String(body.text || "").trim();
      if (!voiceUrl) return json(env, { error: "등록된 목소리가 없습니다." }, 400);
      if (!text) return json(env, { error: "읽을 내용이 없습니다." }, 400);
      if (text.length > max) return json(env, { error: "한 번에 " + max + "자까지만 읽어 줍니다." }, 413);

      const r = await fetch(FAL + "/text-to-speech/" + size, {
        method: "POST", headers: falH,
        body: JSON.stringify({
          text: text, language: "Korean",
          speaker_voice_embedding_file_url: voiceUrl, temperature: 0.7
        })
      });
      const txt = await r.text();
      if (!r.ok) return json(env, { error: "읽지 못했습니다.", status: r.status, detail: txt.slice(0, 300) }, 502);
      let d = {};
      try { d = JSON.parse(txt); } catch (e) {}
      const au = d && d.audio && d.audio.url;
      if (!au) return json(env, { error: "소리를 받지 못했습니다." }, 502);
      const a = await fetch(au);
      if (!a.ok) return json(env, { error: "소리를 내려받지 못했습니다.", status: a.status }, 502);
      return new Response(a.body, {
        status: 200,
        headers: cors(env, { "Content-Type": a.headers.get("Content-Type") || "audio/mpeg" })
      });
    }

    return json(env, { error: "알 수 없는 요청입니다." }, 404);
  }
};
