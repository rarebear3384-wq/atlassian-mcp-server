import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

type AtlassianEnv = {
  ATLASSIAN_SITE_URL: string;
  ATLASSIAN_EMAIL: string;
  ATLASSIAN_API_TOKEN: string;
  MCP_ACCESS_KEY: string;
};

function createServer(env: AtlassianEnv) {
  const server = new McpServer({
    name: "Atlassian MCP",
    version: "1.0.0",
  });

  server.registerTool(
    "atlassian_connection_test",
    {
      description:
        "Tests the Jira Cloud connection and returns the authenticated Atlassian account.",
      inputSchema: {},
    },
    async () => {
      const credentials = btoa(
        `${env.ATLASSIAN_EMAIL}:${env.ATLASSIAN_API_TOKEN}`,
      );

      const response = await fetch(
        `${env.ATLASSIAN_SITE_URL}/rest/api/3/myself`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Basic ${credentials}`,
          },
        },
      );

      const body = await response.text();

      if (!response.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Atlassian connection failed (${response.status}): ${body}`,
            },
          ],
        };
      }

      const account = JSON.parse(body);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                connected: true,
                site: env.ATLASSIAN_SITE_URL,
                displayName: account.displayName,
                accountId: account.accountId,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

export default {
  fetch(request: Request, env: AtlassianEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return new Response(
        "Atlassian MCP server is online. Connect through /mcp.",
        {
          status: 200,
        },
      );
    }

    if (!env.MCP_ACCESS_KEY) {
      return new Response("MCP access key is not configured.", {
        status: 500,
      });
    }

    const authorization = request.headers.get("Authorization") ?? "";

    const suppliedKey = (
      request.headers.get("x-api-key") ||
      request.headers.get("api-key") ||
      authorization
    )
      .replace(/^(Bearer|Api-Key|ApiKey|Token)\s+/i, "")
      .trim();

    const expectedKey = env.MCP_ACCESS_KEY.trim();

    if (suppliedKey !== expectedKey) {
      return new Response("Unauthorized", {
        status: 401,
      });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
