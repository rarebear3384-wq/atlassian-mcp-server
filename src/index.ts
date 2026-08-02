import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type AtlassianEnv = {
  ATLASSIAN_SITE_URL?: string;
  ATLASSIAN_EMAIL?: string;
  ATLASSIAN_API_TOKEN?: string;
  MCP_ACCESS_KEY?: string;
};

function getSiteUrl(env: AtlassianEnv) {
  const siteUrl = env.ATLASSIAN_SITE_URL?.trim().replace(/\/+$/, "");

  if (!siteUrl) {
    throw new Error("ATLASSIAN_SITE_URL is missing from the Worker configuration.");
  }

  return siteUrl;
}

async function jiraRequest(
  env: AtlassianEnv,
  path: string,
  options: RequestInit = {},
) {
  const siteUrl = getSiteUrl(env);

  if (!env.ATLASSIAN_EMAIL) {
    throw new Error("ATLASSIAN_EMAIL is missing from the Worker configuration.");
  }

  if (!env.ATLASSIAN_API_TOKEN) {
    throw new Error(
      "ATLASSIAN_API_TOKEN is missing from the Worker configuration.",
    );
  }

  const credentials = btoa(
    `${env.ATLASSIAN_EMAIL}:${env.ATLASSIAN_API_TOKEN}`,
  );

  const response = await fetch(`${siteUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const body = await response.text();

  let data: any;

  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = body;
  }

  if (!response.ok) {
    throw new Error(
      `Jira request failed (${response.status}): ${body}`,
    );
  }

  return data;
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: String(error),
      },
    ],
  };
}

function createServer(env: AtlassianEnv) {
  const server = new McpServer({
    name: "Atlassian MCP",
    version: "1.2.0",
  });

  server.registerTool(
    "atlassian_connection_test",
    {
      description:
        "Tests the Jira Cloud connection and returns the authenticated Atlassian account.",
      inputSchema: {},
    },
    async () => {
      try {
        const account = await jiraRequest(env, "/rest/api/3/myself");

        return textResult({
          connected: true,
          site: getSiteUrl(env),
          displayName: account.displayName,
          accountId: account.accountId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_projects",
    {
      description:
        "Lists Jira projects the authenticated user can access. Returns no more than 25 projects.",
      inputSchema: {
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum number of projects to return. Defaults to 25."),
      },
    },
    async ({ maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await jiraRequest(
          env,
          `/rest/api/3/project/search?startAt=0&maxResults=${limit}`,
        );

        const projects = Array.isArray(result.values)
          ? result.values.map((project: any) => ({
              id: project.id,
              key: project.key,
              name: project.name,
              projectTypeKey: project.projectTypeKey,
              simplified: project.simplified,
              style: project.style,
              self: project.self,
            }))
          : [];

        return textResult({
          total: result.total ?? projects.length,
          returned: projects.length,
          projects,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_search_issues",
    {
      description:
        "Searches Jira issues using focused JQL and returns no more than 20 compact results.",
      inputSchema: {
        jql: z
          .string()
          .min(1)
          .describe(
            "Focused JQL, such as project = ABC ORDER BY updated DESC.",
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum number of issues to return. Defaults to 10."),
      },
    },
    async ({ jql, maxResults }) => {
      try {
        const limit = maxResults ?? 10;

        const result: any = await jiraRequest(env, "/rest/api/3/search/jql", {
          method: "POST",
          body: JSON.stringify({
            jql,
            maxResults: limit,
            fields: [
              "summary",
              "status",
              "issuetype",
              "project",
              "priority",
              "assignee",
              "reporter",
              "labels",
              "created",
              "updated",
            ],
          }),
        });

        const issues = Array.isArray(result.issues)
          ? result.issues.map((issue: any) => ({
              id: issue.id,
              key: issue.key,
              self: issue.self,
              fields: {
                summary: issue.fields?.summary,
                status: issue.fields?.status?.name,
                issueType: issue.fields?.issuetype?.name,
                project: issue.fields?.project
                  ? {
                      key: issue.fields.project.key,
                      name: issue.fields.project.name,
                    }
                  : undefined,
                priority: issue.fields?.priority?.name,
                assignee: issue.fields?.assignee?.displayName,
                reporter: issue.fields?.reporter?.displayName,
                labels: issue.fields?.labels,
                created: issue.fields?.created,
                updated: issue.fields?.updated,
              },
            }))
          : [];

        return textResult({
          jql,
          returned: issues.length,
          issues,
          nextPageToken: result.nextPageToken ?? null,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_issue",
    {
      description:
        "Retrieves one Jira issue by key, such as ABC-123.",
      inputSchema: {
        issueKey: z
          .string()
          .min(1)
          .describe("The Jira issue key, such as ABC-123."),
      },
    },
    async ({ issueKey }) => {
      try {
        const encodedIssueKey = encodeURIComponent(issueKey.trim());

        const issue: any = await jiraRequest(
          env,
          `/rest/api/3/issue/${encodedIssueKey}?fields=summary,status,issuetype,project,priority,assignee,reporter,labels,description,created,updated`,
        );

        return textResult({
          id: issue.id,
          key: issue.key,
          self: issue.self,
          fields: issue.fields,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export default {
  fetch(request: Request, env: AtlassianEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return new Response(
        JSON.stringify(
          {
            online: true,
            message: "Atlassian MCP server is online.",
            mcpEndpoint: "/mcp",
            configuration: {
              siteUrlConfigured: Boolean(env.ATLASSIAN_SITE_URL),
              emailConfigured: Boolean(env.ATLASSIAN_EMAIL),
              apiTokenConfigured: Boolean(env.ATLASSIAN_API_TOKEN),
              accessKeyConfigured: Boolean(env.MCP_ACCESS_KEY),
            },
          },
          null,
          2,
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
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

    if (suppliedKey !== env.MCP_ACCESS_KEY.trim()) {
      return new Response("Unauthorized", {
        status: 401,
      });
    }

    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
