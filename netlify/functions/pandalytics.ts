// netlify/functions/pandalytics.ts
// Last updated: 2025-09-06 15:50 - Fixed browser detection to use client-sent value

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
  browser?: string; // Client-parsed browser info
  lcp?: number;
  cls?: number;
  fid?: number;
  fcp?: number;
  ttfb?: number;
  inp?: number;
  bounce?: boolean;
}

export const handler: Handler = async (event: HandlerEvent) => {
  // console.log("=== PANDALYTICS REQUEST START ===");
  // console.log("Method:", event.httpMethod);
  // console.log("Headers:", JSON.stringify(event.headers, null, 2));
  // console.log("Body received:", event.body);

  const method = event.httpMethod;

  if (method !== "POST") {
    // console.log("❌ Method not allowed:", method);
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  let bodyData: MetricData;
  try {
    bodyData = JSON.parse(event.body || "{}") as MetricData;
    // console.log("✅ Parsed body data:", JSON.stringify(bodyData, null, 2));
  } catch (error) {
    console.log("❌ JSON parse error:", error);
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
    browser: clientBrowser,
    lcp,
    cls,
    fid,
    fcp,
    ttfb,
    inp,
  } = bodyData;

  // Extract country from Netlify headers if not provided in data
  const finalCountryCode = country_code || (event.headers["x-country"] ?? null);

  if (!session_id || !site_id || !url) {
    console.log("❌ Missing required fields:", {
      session_id: !!session_id,
      site_id: !!site_id,
      url: !!url,
    });
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Missing required fields: session_id, site_id, url",
      }),
    };
  }

  // console.log("✅ All required fields present");

  // Parse browser from user agent
  const parseBrowser = (userAgent: string | null | undefined): string => {
    if (!userAgent) return "Unknown";
    const ua = userAgent.toLowerCase();

    if (ua.includes("firefox/")) {
      const version = userAgent.match(/firefox\/(\d+)/i);
      return `Firefox ${version ? version[1] : ""}`;
    } else if (ua.includes("chrome/") && !ua.includes("edg")) {
      const version = userAgent.match(/chrome\/(\d+)/i);
      return `Chrome ${version ? version[1] : ""}`;
    } else if (ua.includes("edg/")) {
      const version = userAgent.match(/edg\/(\d+)/i);
      return `Edge ${version ? version[1] : ""}`;
    } else if (ua.includes("safari/") && !ua.includes("chrome")) {
      const version = userAgent.match(/version\/(\d+)/i);
      return `Safari ${version ? version[1] : ""}`;
    } else {
      return "Other";
    }
  };

  // Use client-sent browser if available, fallback to server-side parsing
  const browser = clientBrowser || parseBrowser(user_agent);
  const timestamp = Date.now();

  // SQL for upsert session
  const sessionSql = `
    INSERT INTO sessions (
      session_id, site_id, start_time, country_code, 
      screen_width, screen_height, user_agent, browser
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      country_code = COALESCE(country_code, EXCLUDED.country_code),
      screen_width = COALESCE(screen_width, EXCLUDED.screen_width),
      screen_height = COALESCE(screen_height, EXCLUDED.screen_height),
      user_agent = COALESCE(user_agent, EXCLUDED.user_agent),
      browser = COALESCE(browser, EXCLUDED.browser),
      updated_at = strftime('%s', 'now') * 1000
  `;

  // SQL for pageview
  const pageviewSql = `
    INSERT INTO pageviews (
      session_id, url, path, referrer, timestamp,
      lcp, cls, fid, fcp, ttfb, inp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const sessionParams = [
    session_id,
    site_id,
    timestamp,
    finalCountryCode,
    screen_width || null,
    screen_height || null,
    user_agent || null,
    browser,
  ];

  const pageviewParams = [
    session_id,
    url,
    path || null,
    referrer || null,
    timestamp,
    lcp || null,
    cls || null,
    fid || null,
    fcp || null,
    ttfb || null,
    inp || null,
  ];

  // Check required environment variables
  if (
    !process.env.PANDALYTICS_TURSO_REST_ENDPOINT ||
    !process.env.PANDALYTICS_TURSO_API_TOKEN
  ) {
    console.log("❌ Missing required environment variables");
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Server configuration error",
        detail: "Missing database configuration",
      }),
    };
  }

  try {
    // console.log("📤 Sending to Turso (new schema)...");
    // console.log("Session params:", JSON.stringify(sessionParams, null, 2));
    // console.log("Pageview params:", JSON.stringify(pageviewParams, null, 2));

    const requestBody = {
      statements: [
        { q: sessionSql, params: sessionParams },
        { q: pageviewSql, params: pageviewParams },
      ],
    };

    const response = await fetch(process.env.PANDALYTICS_TURSO_REST_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PANDALYTICS_TURSO_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const text = await response.text();
    // console.log("📥 Turso response status:", response.status);
    // console.log("📥 Turso response body:", text);

    if (!response.ok) {
      console.log("❌ Database error occurred");
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

    // console.log("✅ Successfully sent to Turso (new schema)");
    // console.log("=== PANDALYTICS REQUEST END ===");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };
  } catch (error) {
    console.error("❌ Fetch error:", error);
    // console.log("=== PANDALYTICS REQUEST END (ERROR) ===");
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
