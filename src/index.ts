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
        
