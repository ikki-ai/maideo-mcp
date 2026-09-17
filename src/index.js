#!/usr/bin/env node
/**
 * @maideo/mcp — Official MCP server for the Maideo Agent API.
 *
 * Exposes 5 tools that map 1:1 on the public HTTP API:
 *   - search_coverage
 *   - get_quote
 *   - create_booking
 *   - enroll_avance_immediate
 *   - get_booking_status
 *
 * Runs over stdio. Install with `npm i -g @maideo/mcp` then add to your
 * Claude Desktop / Claude Code / ChatGPT MCP client config.
 */
import { createRequire } from "node:module";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

// Read from package.json rather than repeating the literal: the release CI only
// checks the tag against package.json, so a second hardcoded version here could
// drift and ship a server announcing the wrong one.
const PKG_VERSION = createRequire(import.meta.url)("../package.json").version;

const API_BASE =
  process.env.MAIDEO_API_BASE || "https://api.maideo.fr/public/agent";
const AGENT_NAME =
  process.env.MAIDEO_AGENT_NAME || "maideo-mcp-client";

async function apiRequest(path, { method = "GET", body, bookingToken } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Agent-Name": AGENT_NAME,
  };
  if (bookingToken) {
    headers["Authorization"] = `Bearer ${bookingToken}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `Maideo API ${res.status}: ${data.error || res.statusText}`
    );
    err.statusCode = res.status;
    err.details = data.details;
    throw err;
  }
  return data;
}

// bookingId is interpolated into the request path: a bare string let
// "../../x" climb out of /public/agent/booking/ on the same host, carrying the
// caller's bookingToken. The gateway only ever issues a Mongo ObjectId here
// (controllers/public-agent/book.js), and Ajv enforces the pattern since the v2 SDK.
const BOOKING_ID_SCHEMA = {
  type: "string",
  pattern: "^[0-9a-f]{24}$",
  description: "bookingId returned by create_booking",
};

const TOOLS = [
  {
    name: "search_coverage",
    description:
      "Check whether Maideo serves a given French postal code and get the estimated hourly rate (gross, before the 50% tax credit advance). Use this BEFORE get_quote.",
    inputSchema: {
      type: "object",
      required: ["zip"],
      properties: {
        zip: {
          type: "string",
          pattern: "^[0-9]{5}$",
          description: "5-digit French postal code",
        },
        prestation: {
          type: "string",
          enum: ["MENAGE"],
          default: "MENAGE",
        },
      },
    },
  },
  {
    name: "get_quote",
    description:
      "Get a firm price quote for a cleaning booking. Returns a quoteToken valid for 72h that must be passed to create_booking.",
    inputSchema: {
      type: "object",
      required: ["zip", "nbHeuresSemaine", "frequency"],
      properties: {
        zip: { type: "string", pattern: "^[0-9]{5}$" },
        city: { type: "string" },
        nbHeuresSemaine: {
          type: "number",
          minimum: 2,
          description: "Number of hours per intervention",
        },
        nbPrestaSemaine: {
          type: "integer",
          default: 1,
          description: "Number of interventions per week",
        },
        frequency: {
          type: "string",
          enum: ["one_shot", "weekly", "bi_weekly", "monthly"],
        },
        prestation: {
          type: "string",
          enum: ["MENAGE"],
          default: "MENAGE",
        },
        prestationInfo: {
          type: "object",
          properties: {
            houseType: { type: "string" },
            houseSize: { type: "integer" },
            repassage: { type: "boolean" },
            pets: {
              type: "object",
              properties: {
                dog: { type: "boolean" },
                cat: { type: "boolean" },
              },
            },
            comments: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "create_booking",
    description:
      "Create a booking. Requires a quoteToken from get_quote plus the end-user's identity, address, and explicit consent. Returns a bookingToken (72h) for subsequent calls and a bookingId. The booking is held for 48h before worker dispatch as anti-fraud protection.",
    inputSchema: {
      type: "object",
      required: [
        "quoteToken",
        "client",
        "address",
        "dateDebut",
        "agentConsent",
      ],
      properties: {
        quoteToken: { type: "string" },
        client: {
          type: "object",
          required: ["firstName", "lastName", "email", "phone"],
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string", format: "email" },
            phone: { type: "string" },
          },
        },
        address: {
          type: "object",
          required: ["street", "city", "zip"],
          properties: {
            street: { type: "string" },
            city: { type: "string" },
            zip: { type: "string", pattern: "^[0-9]{5}$" },
            country: { type: "string", default: "France" },
          },
        },
        dateDebut: {
          // No `format: "date-time"`: since the v2 SDK, schema keywords are
          // ENFORCED by Ajv before the handler runs, and RFC 3339 would reject
          // "2026-08-15" and offset-less local times that the API accepts
          // (controllers/public-agent/book.js parses with dayjs + isValid).
          // Keeping it would break already-published clients.
          type: "string",
          description:
            "First intervention date, ISO 8601 (e.g. 2026-08-15 or 2026-08-15T09:00:00Z). Must be in the future.",
        },
        frequency: {
          type: "string",
          enum: ["one_shot", "weekly", "bi_weekly", "monthly"],
        },
        nbHeuresSemaine: { type: "number" },
        nbPrestaSemaine: { type: "integer", default: 1 },
        comments: { type: "string" },
        agentConsent: {
          type: "boolean",
          description:
            "Attest that the end-user explicitly consented to share their data via your agent",
        },
      },
    },
  },
  {
    name: "enroll_avance_immediate",
    description:
      "Enroll the end user with URSSAF for the 50% immediate tax credit advance. After this succeeds, the user pays only half the gross hourly rate via SEPA. Required: bookingToken from create_booking, full identity, birth place, postal address, IBAN.",
    inputSchema: {
      type: "object",
      required: [
        "bookingId",
        "bookingToken",
        "civilite",
        "nomNaissance",
        "prenoms",
        "dateNaissance",
        "lieuNaissance",
        "numeroTelephonePortable",
        "adresseMail",
        "adressePostale",
        "coordonneeBancaire",
      ],
      properties: {
        bookingId: BOOKING_ID_SCHEMA,
        bookingToken: { type: "string" },
        civilite: {
          type: "string",
          enum: ["1", "2"],
          description: "1=Monsieur, 2=Madame (NOT M/MME)",
        },
        nomNaissance: { type: "string" },
        nomUsage: { type: "string" },
        prenoms: { type: "string" },
        dateNaissance: { type: "string", format: "date" },
        lieuNaissance: {
          type: "object",
          properties: {
            codePaysNaissance: { type: "string" },
            departementNaissance: { type: "string" },
            communeNaissance: {
              type: "object",
              properties: {
                codeCommune: { type: "string" },
                libelleCommune: { type: "string" },
              },
            },
          },
        },
        numeroTelephonePortable: {
          // Separators tolerated here and stripped before the call: the pattern
          // is enforced by Ajv since the v2 SDK, and a human-formatted
          // "+33 6 12 34 56 78" used to reach the API untouched. URSSAF still
          // receives the compact form.
          type: "string",
          pattern: "^(0|\\+33)[\\s.-]?[6-7]([\\s.-]?[0-9]{2}){4}$",
          description: "French mobile number, e.g. 0612345678 or +33 6 12 34 56 78",
        },
        adresseMail: { type: "string", format: "email" },
        adressePostale: {
          type: "object",
          properties: {
            libelleVoie: { type: "string" },
            libelleCommune: { type: "string" },
            codeCommune: { type: "string" },
            codePostal: { type: "string" },
            codePays: { type: "string" },
          },
        },
        coordonneeBancaire: {
          type: "object",
          required: ["bic", "iban", "titulaire"],
          properties: {
            bic: { type: "string" },
            iban: { type: "string" },
            titulaire: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "get_booking_status",
    description:
      "Poll the current status of a booking (order, mission, worker assignment, URSSAF enrollment). Requires bookingId + bookingToken from create_booking.",
    inputSchema: {
      type: "object",
      required: ["bookingId", "bookingToken"],
      properties: {
        bookingId: BOOKING_ID_SCHEMA,
        bookingToken: { type: "string" },
      },
    },
  },
];

async function callTool(name, args) {
  try {
    let result;
    switch (name) {
      case "search_coverage": {
        const qs = new URLSearchParams({
          zip: args.zip,
          prestation: args.prestation || "MENAGE",
        });
        result = await apiRequest(`/coverage?${qs.toString()}`);
        break;
      }
      case "get_quote": {
        result = await apiRequest("/quote", {
          method: "POST",
          body: args,
        });
        break;
      }
      case "create_booking": {
        result = await apiRequest("/book", {
          method: "POST",
          body: args,
        });
        break;
      }
      case "enroll_avance_immediate": {
        const { bookingId, bookingToken, ...urssafPayload } = args;
        if (urssafPayload.numeroTelephonePortable) {
          urssafPayload.numeroTelephonePortable =
            urssafPayload.numeroTelephonePortable.replace(/[\s.-]/g, "");
        }
        result = await apiRequest(
          `/booking/${encodeURIComponent(bookingId)}/enroll-urssaf`,
          {
            method: "POST",
            body: urssafPayload,
            bookingToken,
          }
        );
        break;
      }
      case "get_booking_status": {
        const { bookingId, bookingToken } = args;
        result = await apiRequest(`/booking/${encodeURIComponent(bookingId)}`, {
          bookingToken,
        });
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error calling ${name}: ${err.message}${
            err.details ? `\nDetails: ${JSON.stringify(err.details)}` : ""
          }`,
        },
      ],
    };
  }
}

// `serveStdio` serves both protocol eras off one factory: already-installed
// clients keep the initialize handshake, a 2026-07-28 client gets the stateless
// protocol and `server/discover`. Both come from the SDK defaults — passing
// `supportedProtocolVersions` would only narrow what `initialize` can negotiate.
function buildServer() {
  const server = new McpServer({ name: "@maideo/mcp", version: PKG_VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
      },
      (args) => callTool(tool.name, args ?? {})
    );
  }
  return server;
}

// Build once eagerly: `serveStdio` only calls its factory on the first client
// message and swallows construction errors into an opaque -32603, so a bad
// schema would otherwise ship as a server that silently answers nothing.
buildServer();

serveStdio(buildServer, {
  onerror: (err) => console.error("[@maideo/mcp] error:", err),
});
console.error("[@maideo/mcp] Server running on stdio");
