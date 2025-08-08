// netlify/functions/analytics.ts
import crypto from "crypto";

const ENABLE_LOGGING = process.env.ANALYTICS_DEBUG === "true" || false;

class TursoHTTPClient {
  private baseUrl: string;
  private authToken: string;

  constructor(databaseUrl: string, authToken: string) {
    // if (ENABLE_LOGGING) console.log("Original database URL:", databaseUrl);

    if (databaseUrl.startsWith("libsql://")) {
      this.baseUrl =
        databaseUrl.replace("libsql://", "https://") + "/v2/pipeline";
    } else if (databaseUrl.startsWith("https://")) {
      this.baseUrl = databaseUrl + "/v2/pipeline";
    } else {
      this.baseUrl = `https://${databaseUrl}/v2/pipeline`;
    }

    this.authToken = authToken;
  }

  async execute(query: { sql: string; args: any[] }) {
    try {
      const tursoArgs = query.args.map((arg) => {
        if (arg === null || arg === undefined) return { type: "null" };
        if (typeof arg === "string") return { type: "text", value: arg };
        if (typeof arg === "number") {
          return Number.isInteger(arg)
            ? { type: "integer", value: arg.toString() }
            : { type: "float", value: arg.toString() };
        }
        if (typeof arg === "boolean") {
          return { type: "integer", value: arg ? "1" : "0" };
        }
        return { type: "text", value: String(arg) };
      });

      const payload = {
        requests: [
          {
            type: "execute",
            stmt: {
              sql: query.sql,
              args: tursoArgs,
            },
          },
        ],
      };

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}. Response: ${responseText}`,
        );
      }

      const result = JSON.parse(responseText);
      if (result[0]?.error) {
        throw new Error(`Turso SQL Error: ${result[0].error.message}`);
      }

      return { rows: result[0]?.response?.result?.rows || [] };
    } catch (error) {
      console.error("Turso HTTP request failed:", error);
      throw error;
    }
  }
}

let client: TursoHTTPClient | null = null;

try {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) {
    client = new TursoHTTPClient(
      process.env.TURSO_DATABASE_URL,
      process.env.TURSO_AUTH_TOKEN,
    );
  } else {
    // if (ENABLE_LOGGING)
    //   console.log("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
  }
} catch (error) {
  console.error("Failed to initialize Turso HTTP client:", error);
}

function hashValue(
  value: string,
  salt = process.env.ANALYTICS_SALT || "default-salt",
) {
  return crypto
    .createHash("sha256")
    .update(value + salt)
    .digest("hex")
    .substring(0, 16);
}

async function getCountryFromIP(ip: string): Promise<string | null> {
  // if (ENABLE_LOGGING) console.log(`Getting country for IP: ${ip} using ip-api.com`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    // Using ip-api.com which has a more generous free tier
    const response = await fetch(
      `http://ip-api.com/json/${ip}?fields=countryCode`,
      {
        signal: controller.signal,
      },
    );
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      const country = data.countryCode || null;
      // if (ENABLE_LOGGING) console.log(`Successfully got country: ${country}`);
      return country;
    } else {
      const errorText = await response.text();
      console.error(
        `Failed to get country from ip-api.com. Status: ${response.status}. Body: ${errorText}`,
      );
    }
  } catch (error) {
    console.error("Error fetching country from ip-api.com:", error);
  }
  return null;
}

function validateAndSanitizeData(data: any) {
  return {
    path: typeof data.path === "string" ? data.path.substring(0, 500) : null,
    referrer:
      typeof data.referrer === "string"
        ? data.referrer.substring(0, 500)
        : null,
    userAgent:
      typeof data.userAgent === "string"
        ? data.userAgent.substring(0, 1000)
        : null,
    sessionId:
      typeof data.sessionId === "string"
        ? data.sessionId.substring(0, 100)
        : null,
    screenWidth:
      typeof data.screenWidth === "number" && data.screenWidth > 0
        ? data.screenWidth
        : null,
    screenHeight:
      typeof data.screenHeight === "number" && data.screenHeight > 0
        ? data.screenHeight
        : null,
    siteUrl:
      typeof data.siteUrl === "string" ? data.siteUrl.substring(0, 500) : null,
  };
}

export const handler = async (event: any, context: any) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (!client) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: "Analytics disabled" }),
    };
  }

  if (event.httpMethod === "POST") {
    try {
      const rawData = JSON.parse(event.body || "{}");
      const data = validateAndSanitizeData(rawData);

      if (!data.path) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Path is required" }),
        };
      }

      const clientIP =
        event.headers["x-nf-client-connection-ip"] ||
        event.headers["x-forwarded-for"]?.split(",")[0] ||
        null;

      // Fallback to header if siteUrl missing
      const siteUrl =
        data.siteUrl ||
        (event.headers["x-forwarded-host"]
          ? `https://${event.headers["x-forwarded-host"]}`
          : null);

      if (
        !siteUrl ||
        siteUrl.includes("localhost") ||
        siteUrl.includes("127.0.0.1")
      ) {
        // if (ENABLE_LOGGING) console.log("Ignoring local dev request:", siteUrl);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ignored: true }),
        };
      }

      const userAgentHash = data.userAgent ? hashValue(data.userAgent) : null;
      const sessionHash = data.sessionId ? hashValue(data.sessionId) : null;

      let countryCode: string | null = null;

      if (sessionHash) {
        const existingSessionResult = await client.execute({
          sql: "SELECT country_code FROM sessions WHERE session_hash = ? LIMIT 1",
          args: [sessionHash],
        });

        const existingSession = existingSessionResult.rows[0];

        if (existingSession && existingSession.country_code) {
          countryCode = existingSession.country_code as string;
          // if (ENABLE_LOGGING) console.log(`Using country from existing session: ${countryCode}`);
        } else {
          // New session or session without country, do the lookup
          if (clientIP) {
            countryCode = await getCountryFromIP(clientIP);
          }

          if (existingSession) {
            // Session exists but has no country, update it
            await client.execute({
              sql: `UPDATE sessions 
                    SET last_page = ?, page_count = page_count + 1, 
                        duration_seconds = (strftime('%s', 'now') - strftime('%s', timestamp)),
                        country_code = ?
                    WHERE session_hash = ?`,
              args: [String(data.path), countryCode, sessionHash],
            });
          } else {
            // New session, create it with the country
            await client.execute({
              sql: `INSERT INTO sessions 
                    (session_hash, first_page, last_page, site_url, user_agent_hash, country_code)
                    VALUES (?, ?, ?, ?, ?, ?)`,
              args: [
                sessionHash,
                String(data.path),
                String(data.path),
                siteUrl,
                userAgentHash,
                countryCode,
              ],
            });
          }
        }
      } else {
        // Fallback if no session ID is provided (should be rare)
        if (clientIP) {
          countryCode = await getCountryFromIP(clientIP);
        }
      }

      // Insert the page view with the determined country code
      await client.execute({
        sql: `INSERT INTO page_views 
              (path, site_url, referrer, user_agent_hash, country_code, screen_width, screen_height, session_hash, is_bounce)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          String(data.path),
          siteUrl,
          data.referrer,
          userAgentHash,
          countryCode,
          data.screenWidth,
          data.screenHeight,
          sessionHash,
          0, // is_bounce - this might need more logic
        ],
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true }),
      };
    } catch (error) {
      console.error("Analytics error:", error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "Failed to track analytics",
          details: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }

  if (event.httpMethod === "GET") {
    try {
      const queryParams = event.queryStringParameters || {};
      const days = Math.min(
        Math.max(parseInt(queryParams.days || "30"), 1),
        365,
      );
      const type = queryParams.type || "pages";

      let sql: string;
      let args: any[] = [days];

      if (type === "daily") {
        sql = `SELECT 
                 DATE(timestamp) as date,
                 COUNT(*) as total_views,
                 COUNT(DISTINCT session_hash) as unique_sessions
               FROM page_views 
               WHERE timestamp >= datetime('now', '-' || ? || ' days')
               GROUP BY DATE(timestamp)
               ORDER BY date DESC`;
      } else {
        sql = `SELECT 
                 path,
                 site_url,
                 COUNT(*) as views,
                 COUNT(DISTINCT session_hash) as unique_sessions,
                 ROUND(AVG(CAST(is_bounce AS REAL)) * 100, 2) as bounce_rate_percent
               FROM page_views 
               WHERE timestamp >= datetime('now', '-' || ? || ' days')
               GROUP BY path, site_url
               ORDER BY views DESC`;
      }

      const result = await client.execute({ sql, args });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result.rows }),
      };
    } catch (error) {
      console.error("Analytics fetch error:", error);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Failed to fetch analytics" }),
      };
    }
  }

  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ error: "Method not allowed" }),
  };
};
