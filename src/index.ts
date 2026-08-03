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
    throw new Error("ATLASSIAN_SITE_URL is missing.");
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
    throw new Error("ATLASSIAN_EMAIL is missing.");
  }

  if (!env.ATLASSIAN_API_TOKEN) {
    throw new Error("ATLASSIAN_API_TOKEN is missing.");
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
      `Atlassian request failed (${response.status}): ${body}`,
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

function requireConfirmation(
  action: string,
  details: Record<string, unknown>,
  confirm?: boolean,
) {
  if (confirm !== true) {
    return textResult({
      preview: true,
      action,
      message:
        "No changes were made. Review this proposal and call the tool again with confirm=true to execute it.",
      details,
    });
  }

  return null;
}

function parseJsonObject(value: string | undefined, fieldName: string) {
  if (!value) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${fieldName} must contain valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must contain a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function toDescriptionDocument(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
          },
        ],
      },
    ],
  };
}

function createServer(env: AtlassianEnv) {
  const server = new McpServer({
    name: "Atlassian MCP",
    version: "1.3.0",
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
        jql: z.string().min(1).describe("Focused Jira Query Language expression."),
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
              summary: issue.fields?.summary,
              status: issue.fields?.status?.name,
              issueType: issue.fields?.issuetype?.name,
              project: issue.fields?.project?.key,
              priority: issue.fields?.priority?.name,
              assignee: issue.fields?.assignee?.displayName,
              reporter: issue.fields?.reporter?.displayName,
              labels: issue.fields?.labels,
              created: issue.fields?.created,
              updated: issue.fields?.updated,
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
        issueKey: z.string().min(1),
      },
    },
    async ({ issueKey }) => {
      try {
        const issue: any = await jiraRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}?fields=summary,status,issuetype,project,priority,assignee,reporter,labels,description,created,updated`,
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

  server.registerTool(
    "jira_create_issue",
    {
      description:
        "Creates a Jira issue after presenting a preview. Set confirm=true only after the user approves the proposal.",
      inputSchema: {
        projectKey: z.string().min(1),
        summary: z.string().min(1),
        issueType: z.string().min(1).describe("Example: Task, Story, Bug, or Epic."),
        description: z.string().optional(),
        additionalFieldsJson: z
          .string()
          .optional()
          .describe("Optional JSON object containing additional Jira fields."),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      projectKey,
      summary,
      issueType,
      description,
      additionalFieldsJson,
      confirm,
    }) => {
      try {
        const additionalFields = parseJsonObject(
          additionalFieldsJson,
          "additionalFieldsJson",
        );

        const fields: Record<string, unknown> = {
          project: {
            key: projectKey,
          },
          summary,
          issuetype: {
            name: issueType,
          },
          ...additionalFields,
        };

        if (description) {
          fields.description = toDescriptionDocument(description);
        }

        const preview = requireConfirmation(
          "Create Jira issue",
          {
            projectKey,
            summary,
            issueType,
            description,
            fields,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const created: any = await jiraRequest(env, "/rest/api/3/issue", {
          method: "POST",
          body: JSON.stringify({ fields }),
        });

        return textResult({
          executed: true,
          action: "create_issue",
          issueKey: created.key,
          issueId: created.id,
          url: `${getSiteUrl(env)}/browse/${created.key}`,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_update_issue",
    {
      description:
        "Updates Jira issue fields after presenting a preview. Set confirm=true only after approval.",
      inputSchema: {
        issueKey: z.string().min(1),
        fieldsJson: z
          .string()
          .min(2)
          .describe("JSON object containing Jira fields to update."),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, fieldsJson, confirm }) => {
      try {
        const fields = parseJsonObject(fieldsJson, "fieldsJson");

        const preview = requireConfirmation(
          "Update Jira issue",
          {
            issueKey,
            fields,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await jiraRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}`,
          {
            method: "PUT",
            body: JSON.stringify({ fields }),
          },
        );

        return textResult({
          executed: true,
          action: "update_issue",
          issueKey,
          url: `${getSiteUrl(env)}/browse/${issueKey}`,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_add_comment",
    {
      description:
        "Adds a comment to a Jira issue after presenting a preview. Set confirm=true only after approval.",
      inputSchema: {
        issueKey: z.string().min(1),
        comment: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, comment, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Add Jira comment",
          {
            issueKey,
            comment,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const result: any = await jiraRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/comment`,
          {
            method: "POST",
            body: JSON.stringify({
              body: toDescriptionDocument(comment),
            }),
          },
        );

        return textResult({
          executed: true,
          action: "add_comment",
          issueKey,
          commentId: result.id,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_assign_issue",
    {
      description:
        "Assigns a Jira issue to an Atlassian account ID after presenting a preview.",
      inputSchema: {
        issueKey: z.string().min(1),
        accountId: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, accountId, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Assign Jira issue",
          {
            issueKey,
            accountId,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await jiraRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/assignee`,
          {
            method: "PUT",
            body: JSON.stringify({
              accountId,
            }),
          },
        );

        return textResult({
          executed: true,
          action: "assign_issue",
          issueKey,
          accountId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_transitions",
    {
      description:
        "Lists the workflow transitions currently available for a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1),
      },
    },
    async ({ issueKey }) => {
      try {
        const result: any = await jiraRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/transitions`,
        );

        return textResult({
          issueKey,
          transitions: result.transitions ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_transition_issue",
    {
      description:
        "Transitions a Jira issue after presenting a preview. Use jira_get_transitions first.",
      inputSchema: {
        issueKey: z.string().min(1),
        transitionId: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, transitionId, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Transition Jira issue",
          {
            issueKey,
            transitionId,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await jiraRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/transitions`,
          {
            method: "POST",
            body: JSON.stringify({
              transition: {
                id: transitionId,
              },
            }),
          },
        );

        return textResult({
          executed: true,
          action: "transition_issue",
          issueKey,
          transitionId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_link_issues",
    {
      description:
        "Links two Jira issues after presenting a preview. Set confirm=true only after approval.",
      inputSchema: {
        inwardIssueKey: z.string().min(1),
        outwardIssueKey: z.string().min(1),
        linkType: z
          .string()
          .min(1)
          .describe("Example: Blocks, Relates, Cloners, or Duplicate."),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      inwardIssueKey,
      outwardIssueKey,
      linkType,
      confirm,
    }) => {
      try {
        const preview = requireConfirmation(
          "Link Jira issues",
          {
            inwardIssueKey,
            outwardIssueKey,
            linkType,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await jiraRequest(env, "/rest/api/3/issueLink", {
          method: "POST",
          body: JSON.stringify({
            type: {
              name: linkType,
            },
            inwardIssue: {
              key: inwardIssueKey,
            },
            outwardIssue: {
              key: outwardIssueKey,
            },
          }),
        });

        return textResult({
          executed: true,
          action: "link_issues",
          inwardIssueKey,
          outwardIssueKey,
          linkType,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_fields",
    {
      description:
        "Lists Jira fields and custom field IDs. Useful before updating custom fields or Jira Product Discovery ideas.",
      inputSchema: {},
    },
    async () => {
      try {
        const fields: any = await jiraRequest(env, "/rest/api/3/field");

        const compactFields = Array.isArray(fields)
          ? fields.map((field: any) => ({
              id: field.id,
              name: field.name,
              custom: field.custom,
              schema: field.schema,
            }))
          : [];

        return textResult({
          returned: compactFields.length,
          fields: compactFields,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_project",
    {
      description:
        "Retrieves configuration and metadata for one Jira project.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const project: any = await jiraRequest(
          env,
          `/rest/api/3/project/${encodeURIComponent(projectKey.trim())}`,
        );

        return textResult(project);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_boards",
    {
      description:
        "Lists Jira Software boards visible to the authenticated user. Returns no more than 25.",
      inputSchema: {
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum number of boards to return. Defaults to 25."),
      },
    },
    async ({ maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await jiraRequest(
          env,
          `/rest/agile/1.0/board?startAt=0&maxResults=${limit}`,
        );

        return textResult({
          total: result.total ?? result.values?.length ?? 0,
          returned: result.values?.length ?? 0,
          boards: result.values ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_sprints",
    {
      description:
        "Lists sprints for a Jira Software board. Returns no more than 25.",
      inputSchema: {
        boardId: z.number().int().positive(),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum number of sprints to return. Defaults to 25."),
      },
    },
    async ({ boardId, maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await jiraRequest(
          env,
          `/rest/agile/1.0/board/${boardId}/sprint?startAt=0&maxResults=${limit}`,
        );

        return textResult({
          total: result.total ?? result.values?.length ?? 0,
          returned: result.values?.length ?? 0,
          sprints: result.values ?? [],
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
