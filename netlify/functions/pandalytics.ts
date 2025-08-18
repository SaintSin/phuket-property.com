// netlify/functions/pandalytics.ts

import type { Handler, HandlerEvent } from "@netlify/functions";

interface MetricData {
  session_id: string;
  site_id: string;
  url: string;
  path?: string;
  referrer?: string;
  country_code?: string;
  screen_width?: number;
  screen_height?: number;
  user_agent?: string;
  lcp?: number;
  cls?: number;
  fid?: number;
  fcp?: number;
  ttfb?: number;
  inp?: number;
  duration_ms?: number;
  bounce?: boolean;
  pageviews_in_session?: number;
}

export const handler: Handler = async (event: HandlerEvent) => {
  const method = event.httpMethod;

  if (method !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let bodyData: MetricData;
  try {
    bodyData = JSON.parse(event.body || "{}") as MetricData;
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const {
    session_id,
    site_id,
    url,
    path,
    referrer,
    country_code,
    screen_width,
    screen_height,
    user_agent,
    lcp,
    cls,
    fid,
    fcp,
    ttfb,
    inp,
    duration_ms,
    bounce,
    pageviews_in_session,
  } = bodyData;

  if (!session_id || !site_id || !url) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Missing required fields: session_id, site_id, url",
      }),
    };
  }

  const sql = `
    INSERT INTO metrics (
      session_id, site_id, url, path, referrer, country_code,
      screen_width, screen_height, user_agent,
      lcp, cls, fid, fcp, ttfb, inp,
      duration_ms, bounce, pageviews_in_session, ts
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `;

  const params: (string | number | boolean | null)[] = [
    session_id,
    site_id,
    url,
    path || null,
    referrer || null,
    country_code || null,
    screen_width || null,
    screen_height || null,
    user_agent || null,
    lcp || null,
    cls || null,
    fid || null,
    fcp || null,
    ttfb || null,
    inp || null,
    duration_ms || null,
    bounce || null,
    pageviews_in_session || null,
    Date.now(),
  ];

  try {
    console.log("Sending to Turso with correct JSON shape...");

    const response = await fetch(process.env.TURSO_REST_ENDPOINT!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TURSO_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statements: [{ q: sql, params }],
      }),
    });

    const text = await response.text();
    // console.log("Turso response status:", response.status);
    // console.log("Turso response body:", text);

    if (!response.ok) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Database error",
          status: response.status,
          detail: text,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };
  } catch (error) {
    console.error("Fetch error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal server error",
        detail: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};
