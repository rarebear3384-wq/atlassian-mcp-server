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

async function atlassianRequest(
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
    throw new Error(`Atlassian request failed (${response.status}): ${body}`);
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

function jiraDocument(text: string) {
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

function confluenceStorageBody(value: string) {
  return {
    representation: "storage",
    value,
  };
}

function createServer(env: AtlassianEnv) {
  const server = new McpServer({
    name: "Atlassian MCP",
    version: "1.4.0",
  });

  server.registerTool(
    "atlassian_connection_test",
    {
      description:
        "Tests the Jira Cloud connection and returns the authenticated account.",
      inputSchema: {},
    },
    async () => {
      try {
        const account = await atlassianRequest(env, "/rest/api/3/myself");

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
      description: "Lists Jira projects accessible to the authenticated user.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await atlassianRequest(
          env,
          `/rest/api/3/project/search?startAt=0&maxResults=${limit}`,
        );

        return textResult({
          total: result.total ?? 0,
          projects: result.values ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_project",
    {
      description: "Retrieves metadata for a Jira project.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/project/${encodeURIComponent(projectKey.trim())}`,
        );

        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_search_issues",
    {
      description: "Searches Jira issues using JQL.",
      inputSchema: {
        jql: z.string().min(1),
        maxResults: z.number().int().min(1).max(20).optional(),
      },
    },
    async ({ jql, maxResults }) => {
      try {
        const result: any = await atlassianRequest(
          env,
          "/rest/api/3/search/jql",
          {
            method: "POST",
            body: JSON.stringify({
              jql,
              maxResults: maxResults ?? 10,
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
          },
        );

        return textResult({
          jql,
          returned: result.issues?.length ?? 0,
          issues: result.issues ?? [],
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
      description: "Retrieves one Jira issue by key.",
      inputSchema: {
        issueKey: z.string().min(1),
      },
    },
    async ({ issueKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}?fields=*all`,
        );

        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_create_issue",
    {
      description:
        "Creates a Jira issue. Without confirm=true, only returns a preview.",
      inputSchema: {
        projectKey: z.string().min(1),
        summary: z.string().min(1),
        issueType: z.string().min(1),
        description: z.string().optional(),
        additionalFieldsJson: z.string().optional(),
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
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType },
          ...additionalFields,
        };

        if (description) {
          fields.description = jiraDocument(description);
        }

        const preview = requireConfirmation(
          "Create Jira issue",
          { projectKey, summary, issueType, description, fields },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const result: any = await atlassianRequest(
          env,
          "/rest/api/3/issue",
          {
            method: "POST",
            body: JSON.stringify({ fields }),
          },
        );

        return textResult({
          executed: true,
          issueKey: result.key,
          issueId: result.id,
          url: `${getSiteUrl(env)}/browse/${result.key}`,
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
        "Updates Jira issue fields. Without confirm=true, only returns a preview.",
      inputSchema: {
        issueKey: z.string().min(1),
        fieldsJson: z.string().min(2),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, fieldsJson, confirm }) => {
      try {
        const fields = parseJsonObject(fieldsJson, "fieldsJson");

        const preview = requireConfirmation(
          "Update Jira issue",
          { issueKey, fields },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}`,
          {
            method: "PUT",
            body: JSON.stringify({ fields }),
          },
        );

        return textResult({
          executed: true,
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
        "Adds a Jira issue comment. Without confirm=true, only returns a preview.",
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
          { issueKey, comment },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const result: any = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/comment`,
          {
            method: "POST",
            body: JSON.stringify({
              body: jiraDocument(comment),
            }),
          },
        );

        return textResult({
          executed: true,
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
        "Assigns a Jira issue. Without confirm=true, only returns a preview.",
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
          { issueKey, accountId },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/assignee`,
          {
            method: "PUT",
            body: JSON.stringify({ accountId }),
          },
        );

        return textResult({
          executed: true,
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
      description: "Lists workflow transitions available for a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1),
      },
    },
    async ({ issueKey }) => {
      try {
        const result: any = await atlassianRequest(
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
        "Transitions a Jira issue. Without confirm=true, only returns a preview.",
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
          { issueKey, transitionId },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}/transitions`,
          {
            method: "POST",
            body: JSON.stringify({
              transition: { id: transitionId },
            }),
          },
        );

        return textResult({
          executed: true,
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
        "Links two Jira issues. Without confirm=true, only returns a preview.",
      inputSchema: {
        inwardIssueKey: z.string().min(1),
        outwardIssueKey: z.string().min(1),
        linkType: z.string().min(1),
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
          { inwardIssueKey, outwardIssueKey, linkType },
          confirm,
        );

        if (preview) {
          return preview;
        }

        await atlassianRequest(env, "/rest/api/3/issueLink", {
          method: "POST",
          body: JSON.stringify({
            type: { name: linkType },
            inwardIssue: { key: inwardIssueKey },
            outwardIssue: { key: outwardIssueKey },
          }),
        });

        return textResult({
          executed: true,
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
      description: "Lists Jira fields and custom field IDs.",
      inputSchema: {},
    },
    async () => {
      try {
        const fields: any = await atlassianRequest(env, "/rest/api/3/field");

        return textResult({
          returned: fields?.length ?? 0,
          fields: fields ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_boards",
    {
      description: "Lists Jira Software boards.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await atlassianRequest(
          env,
          `/rest/agile/1.0/board?startAt=0&maxResults=${limit}`,
        );

        return textResult({
          total: result.total ?? 0,
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
      description: "Lists sprints for a Jira Software board.",
      inputSchema: {
        boardId: z.number().int().positive(),
        maxResults: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ boardId, maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await atlassianRequest(
          env,
          `/rest/agile/1.0/board/${boardId}/sprint?startAt=0&maxResults=${limit}`,
        );

        return textResult({
          total: result.total ?? 0,
          sprints: result.values ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_list_spaces",
    {
      description: "Lists Confluence spaces accessible to the authenticated user.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await atlassianRequest(
          env,
          `/wiki/rest/api/space?limit=${limit}`,
        );

        return textResult({
          total: result.size ?? result.results?.length ?? 0,
          spaces: result.results ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_search",
    {
      description:
        "Searches Confluence using CQL. Example: type=page AND text~\"release plan\".",
      inputSchema: {
        cql: z.string().min(1),
        maxResults: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ cql, maxResults }) => {
      try {
        const limit = maxResults ?? 10;

        const result: any = await atlassianRequest(
          env,
          `/wiki/rest/api/content/search?cql=${encodeURIComponent(
            cql,
          )}&limit=${limit}&expand=space,version`,
        );

        return textResult({
          cql,
          returned: result.results?.length ?? 0,
          results: result.results ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_get_page",
    {
      description: "Retrieves a Confluence page including its storage content.",
      inputSchema: {
        pageId: z.string().min(1),
      },
    },
    async ({ pageId }) => {
      try {
        const page = await atlassianRequest(
          env,
          `/wiki/rest/api/content/${encodeURIComponent(
            pageId,
          )}?expand=body.storage,space,version,ancestors`,
        );

        return textResult(page);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_list_child_pages",
    {
      description: "Lists child pages beneath a Confluence page.",
      inputSchema: {
        pageId: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ pageId, maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await atlassianRequest(
          env,
          `/wiki/rest/api/content/${encodeURIComponent(
            pageId,
          )}/child/page?limit=${limit}&expand=space,version`,
        );

        return textResult({
          returned: result.results?.length ?? 0,
          pages: result.results ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_get_page_versions",
    {
      description: "Retrieves version history for a Confluence page.",
      inputSchema: {
        pageId: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ pageId, maxResults }) => {
      try {
        const limit = maxResults ?? 25;

        const result: any = await atlassianRequest(
          env,
          `/wiki/rest/api/content/${encodeURIComponent(
            pageId,
          )}/version?limit=${limit}`,
        );

        return textResult({
          returned: result.results?.length ?? 0,
          versions: result.results ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_create_page",
    {
      description:
        "Creates a Confluence page. Without confirm=true, only returns a preview.",
      inputSchema: {
        spaceKey: z.string().min(1),
        title: z.string().min(1),
        bodyStorageHtml: z.string().min(1),
        parentPageId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      spaceKey,
      title,
      bodyStorageHtml,
      parentPageId,
      confirm,
    }) => {
      try {
        const payload: Record<string, unknown> = {
          type: "page",
          title,
          space: { key: spaceKey },
          body: {
            storage: confluenceStorageBody(bodyStorageHtml),
          },
        };

        if (parentPageId) {
          payload.ancestors = [{ id: parentPageId }];
        }

        const preview = requireConfirmation(
          "Create Confluence page",
          {
            spaceKey,
            title,
            parentPageId,
            bodyStorageHtml,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const result: any = await atlassianRequest(
          env,
          "/wiki/rest/api/content",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          pageId: result.id,
          title: result.title,
          url: `${getSiteUrl(env)}/wiki${result._links?.webui ?? ""}`,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_update_page",
    {
      description:
        "Updates a Confluence page. Without confirm=true, only returns a preview.",
      inputSchema: {
        pageId: z.string().min(1),
        title: z.string().min(1),
        bodyStorageHtml: z.string().min(1),
        currentVersion: z.number().int().positive(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      pageId,
      title,
      bodyStorageHtml,
      currentVersion,
      confirm,
    }) => {
      try {
        const payload = {
          version: {
            number: currentVersion + 1,
          },
          title,
          type: "page",
          body: {
            storage: confluenceStorageBody(bodyStorageHtml),
          },
        };

        const preview = requireConfirmation(
          "Update Confluence page",
          {
            pageId,
            title,
            currentVersion,
            newVersion: currentVersion + 1,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const result: any = await atlassianRequest(
          env,
          `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          pageId: result.id,
          title: result.title,
          version: result.version?.number,
          url: `${getSiteUrl(env)}/wiki${result._links?.webui ?? ""}`,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "confluence_add_comment",
    {
      description:
        "Adds a comment to a Confluence page. Without confirm=true, only returns a preview.",
      inputSchema: {
        pageId: z.string().min(1),
        comment: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ pageId, comment, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Add Confluence page comment",
          {
            pageId,
            comment,
          },
          confirm,
        );

        if (preview) {
          return preview;
        }

        const result: any = await atlassianRequest(
          env,
          "/wiki/rest/api/content",
          {
            method: "POST",
            body: JSON.stringify({
              type: "comment",
              container: {
                type: "page",
                id: pageId,
              },
              body: {
                storage: confluenceStorageBody(comment),
              },
            }),
          },
        );

        return textResult({
          executed: true,
          commentId: result.id,
          pageId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );


  server.registerTool(
    "jira_get_issue_changelog",
    {
      description: "Retrieves the change history for a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ issueKey, maxResults }) => {
      try {
        const limit = maxResults ?? 50;
        const result = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(
            issueKey.trim(),
          )}?expand=changelog&fields=summary,status`,
        );

        return textResult({
          issueKey,
          summary: result.fields?.summary,
          status: result.fields?.status,
          total: result.changelog?.total ?? 0,
          histories: (result.changelog?.histories ?? []).slice(0, limit),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_worklogs",
    {
      description: "Lists worklogs recorded against a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ issueKey, maxResults }) => {
      try {
        const limit = maxResults ?? 50;
        const result = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(
            issueKey.trim(),
          )}/worklog?maxResults=${limit}`,
        );

        return textResult({
          issueKey,
          total: result.total ?? 0,
          worklogs: result.worklogs ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_add_worklog",
    {
      description:
        "Adds worklog time to a Jira issue. Without confirm=true, only returns a preview.",
      inputSchema: {
        issueKey: z.string().min(1),
        timeSpent: z.string().min(1).describe("Example: 1h 30m."),
        started: z.string().optional().describe("ISO timestamp."),
        comment: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, timeSpent, started, comment, confirm }) => {
      try {
        const payload: Record<string, unknown> = { timeSpent };

        if (started) payload.started = started;
        if (comment) payload.comment = jiraDocument(comment);

        const preview = requireConfirmation(
          "Add Jira worklog",
          { issueKey, timeSpent, started, comment },
          confirm,
        );

        if (preview) return preview;

        const result: any = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(
            issueKey.trim(),
          )}/worklog`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          issueKey,
          worklogId: result.id,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_attachments",
    {
      description: "Lists attachment metadata for a Jira issue.",
      inputSchema: {
        issueKey: z.string().min(1),
      },
    },
    async ({ issueKey }) => {
      try {
        const result: any = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(
            issueKey.trim(),
          )}?fields=attachment`,
        );

        return textResult({
          issueKey,
          attachments: result.fields?.attachment ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_delete_attachment",
    {
      description:
        "Deletes a Jira attachment. Without confirm=true, only returns a preview.",
      inputSchema: {
        attachmentId: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ attachmentId, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Delete Jira attachment",
          { attachmentId },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(
          env,
          `/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`,
          { method: "DELETE" },
        );

        return textResult({
          executed: true,
          attachmentId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_versions",
    {
      description: "Lists releases and versions for a Jira project.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/project/${encodeURIComponent(
            projectKey.trim(),
          )}/versions`,
        );

        return textResult({
          projectKey,
          versions: result ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_create_version",
    {
      description:
        "Creates a Jira release/version. Without confirm=true, only returns a preview.",
      inputSchema: {
        projectId: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        releaseDate: z.string().optional().describe("YYYY-MM-DD."),
        released: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      projectId,
      name,
      description,
      releaseDate,
      released,
      confirm,
    }) => {
      try {
        const payload: Record<string, unknown> = {
          project: projectId,
          name,
          released: released ?? false,
        };

        if (description) payload.description = description;
        if (releaseDate) payload.releaseDate = releaseDate;

        const preview = requireConfirmation(
          "Create Jira version",
          payload,
          confirm,
        );

        if (preview) return preview;

        const result = await atlassianRequest(
          env,
          "/rest/api/3/version",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          version: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_components",
    {
      description: "Lists components for a Jira project.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/project/${encodeURIComponent(
            projectKey.trim(),
          )}/components`,
        );

        return textResult({
          projectKey,
          components: result ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_create_component",
    {
      description:
        "Creates a Jira project component. Without confirm=true, only returns a preview.",
      inputSchema: {
        projectId: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        leadAccountId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      projectId,
      name,
      description,
      leadAccountId,
      confirm,
    }) => {
      try {
        const payload: Record<string, unknown> = {
          project: projectId,
          name,
        };

        if (description) payload.description = description;
        if (leadAccountId) payload.leadAccountId = leadAccountId;

        const preview = requireConfirmation(
          "Create Jira component",
          payload,
          confirm,
        );

        if (preview) return preview;

        const result = await atlassianRequest(
          env,
          "/rest/api/3/component",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          component: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_board_issues",
    {
      description: "Lists issues on a Jira Software board.",
      inputSchema: {
        boardId: z.number().int().positive(),
        maxResults: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ boardId, maxResults }) => {
      try {
        const limit = maxResults ?? 25;
        const result = await atlassianRequest(
          env,
          `/rest/agile/1.0/board/${boardId}/issue?maxResults=${limit}`,
        );

        return textResult({
          boardId,
          total: result.total ?? 0,
          issues: result.issues ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_move_issues_to_backlog",
    {
      description:
        "Moves Jira issues to the backlog. Without confirm=true, only returns a preview.",
      inputSchema: {
        issueKeys: z.array(z.string().min(1)).min(1).max(50),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKeys, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Move Jira issues to backlog",
          { issueKeys },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(env, "/rest/agile/1.0/backlog/issue", {
          method: "POST",
          body: JSON.stringify({ issues: issueKeys }),
        });

        return textResult({
          executed: true,
          issueKeys,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_add_issues_to_sprint",
    {
      description:
        "Adds Jira issues to a sprint. Without confirm=true, only returns a preview.",
      inputSchema: {
        sprintId: z.number().int().positive(),
        issueKeys: z.array(z.string().min(1)).min(1).max(50),
        confirm: z.boolean().optional(),
      },
    },
    async ({ sprintId, issueKeys, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Add Jira issues to sprint",
          { sprintId, issueKeys },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(
          env,
          `/rest/agile/1.0/sprint/${sprintId}/issue`,
          {
            method: "POST",
            body: JSON.stringify({ issues: issueKeys }),
          },
        );

        return textResult({
          executed: true,
          sprintId,
          issueKeys,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jpd_list_ideas",
    {
      description:
        "Lists recent Jira Product Discovery ideas. Defaults to the TOPS project.",
      inputSchema: {
        projectKey: z.string().min(1).optional(),
        maxResults: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ projectKey, maxResults }) => {
      try {
        const key = projectKey ?? "TOPS";
        const limit = maxResults ?? 10;
        const result: any = await atlassianRequest(
          env,
          "/rest/api/3/search/jql",
          {
            method: "POST",
            body: JSON.stringify({
              jql: `project = "${key}" ORDER BY updated DESC`,
              maxResults: limit,
              fields: ["summary", "status", "issuetype", "project", "priority", "labels", "created", "updated"],
            }),
          },
        );

        return textResult({
          projectKey: key,
          returned: result.issues?.length ?? 0,
          ideas: result.issues ?? [],
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jpd_get_idea_fields",
    {
      description:
        "Retrieves all fields and current values for a Jira Product Discovery idea.",
      inputSchema: {
        issueKey: z.string().min(1),
      },
    },
    async ({ issueKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}?fields=*all`,
        );

        return textResult({
          issueKey,
          fields: result.fields ?? {},
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );



  server.registerTool(
    "jira_delete_issue",
    {
      description:
        "Deletes a Jira issue. Without confirm=true, only returns a preview.",
      inputSchema: {
        issueKey: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Delete Jira issue",
          { issueKey },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}`,
          { method: "DELETE" },
        );

        return textResult({
          executed: true,
          issueKey,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_sprint",
    {
      description: "Retrieves details for a Jira sprint.",
      inputSchema: {
        sprintId: z.number().int().positive(),
      },
    },
    async ({ sprintId }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/agile/1.0/sprint/${sprintId}`,
        );

        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_create_sprint",
    {
      description:
        "Creates a Jira sprint. Without confirm=true, only returns a preview.",
      inputSchema: {
        name: z.string().min(1),
        boardId: z.number().int().positive(),
        goal: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({ name, boardId, goal, startDate, endDate, confirm }) => {
      try {
        const payload: Record<string, unknown> = {
          name,
          originBoardId: boardId,
        };

        if (goal) payload.goal = goal;
        if (startDate) payload.startDate = startDate;
        if (endDate) payload.endDate = endDate;

        const preview = requireConfirmation(
          "Create Jira sprint",
          payload,
          confirm,
        );

        if (preview) return preview;

        const result = await atlassianRequest(
          env,
          "/rest/agile/1.0/sprint",
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          sprint: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_update_sprint",
    {
      description:
        "Updates a Jira sprint. Without confirm=true, only returns a preview.",
      inputSchema: {
        sprintId: z.number().int().positive(),
        name: z.string().min(1).optional(),
        goal: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        state: z.enum(["future", "active", "closed"]).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      sprintId,
      name,
      goal,
      startDate,
      endDate,
      state,
      confirm,
    }) => {
      try {
        const payload: Record<string, unknown> = {};

        if (name !== undefined) payload.name = name;
        if (goal !== undefined) payload.goal = goal;
        if (startDate !== undefined) payload.startDate = startDate;
        if (endDate !== undefined) payload.endDate = endDate;
        if (state !== undefined) payload.state = state;

        const preview = requireConfirmation(
          "Update Jira sprint",
          { sprintId, ...payload },
          confirm,
        );

        if (preview) return preview;

        const result = await atlassianRequest(
          env,
          `/rest/agile/1.0/sprint/${sprintId}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          sprint: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_issue_types_for_project",
    {
      description: "Lists issue types available for a Jira project.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/issue/createmeta/${encodeURIComponent(
            projectKey.trim(),
          )}/issuetypes`,
        );

        return textResult({
          projectKey,
          issueTypes: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_get_project_permissions",
    {
      description:
        "Checks the authenticated user's Jira permissions for a project.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/mypermissions?projectKey=${encodeURIComponent(
            projectKey.trim(),
          )}`,
        );

        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_list_project_roles",
    {
      description: "Lists project roles and their assigned members.",
      inputSchema: {
        projectKey: z.string().min(1),
      },
    },
    async ({ projectKey }) => {
      try {
        const result = await atlassianRequest(
          env,
          `/rest/api/3/project/${encodeURIComponent(
            projectKey.trim(),
          )}/role`,
        );

        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_update_version",
    {
      description:
        "Updates a Jira release/version. Without confirm=true, only returns a preview.",
      inputSchema: {
        versionId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        releaseDate: z.string().optional(),
        released: z.boolean().optional(),
        archived: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      versionId,
      name,
      description,
      releaseDate,
      released,
      archived,
      confirm,
    }) => {
      try {
        const payload: Record<string, unknown> = {};

        if (name !== undefined) payload.name = name;
        if (description !== undefined) payload.description = description;
        if (releaseDate !== undefined) payload.releaseDate = releaseDate;
        if (released !== undefined) payload.released = released;
        if (archived !== undefined) payload.archived = archived;

        const preview = requireConfirmation(
          "Update Jira version",
          { versionId, ...payload },
          confirm,
        );

        if (preview) return preview;

        const result = await atlassianRequest(
          env,
          `/rest/api/3/version/${encodeURIComponent(versionId)}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          version: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_delete_version",
    {
      description:
        "Deletes a Jira release/version. Without confirm=true, only returns a preview.",
      inputSchema: {
        versionId: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ versionId, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Delete Jira version",
          { versionId },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(
          env,
          `/rest/api/3/version/${encodeURIComponent(versionId)}`,
          { method: "DELETE" },
        );

        return textResult({
          executed: true,
          versionId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_update_component",
    {
      description:
        "Updates a Jira component. Without confirm=true, only returns a preview.",
      inputSchema: {
        componentId: z.string().min(1),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        leadAccountId: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async ({
      componentId,
      name,
      description,
      leadAccountId,
      confirm,
    }) => {
      try {
        const payload: Record<string, unknown> = {};

        if (name !== undefined) payload.name = name;
        if (description !== undefined) payload.description = description;
        if (leadAccountId !== undefined) {
          payload.leadAccountId = leadAccountId;
        }

        const preview = requireConfirmation(
          "Update Jira component",
          { componentId, ...payload },
          confirm,
        );

        if (preview) return preview;

        const result = await atlassianRequest(
          env,
          `/rest/api/3/component/${encodeURIComponent(componentId)}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
        );

        return textResult({
          executed: true,
          component: result,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jira_delete_component",
    {
      description:
        "Deletes a Jira component. Without confirm=true, only returns a preview.",
      inputSchema: {
        componentId: z.string().min(1),
        confirm: z.boolean().optional(),
      },
    },
    async ({ componentId, confirm }) => {
      try {
        const preview = requireConfirmation(
          "Delete Jira component",
          { componentId },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(
          env,
          `/rest/api/3/component/${encodeURIComponent(componentId)}`,
          { method: "DELETE" },
        );

        return textResult({
          executed: true,
          componentId,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "jpd_update_fields",
    {
      description:
        "Updates JPD scoring or other custom fields. Without confirm=true, only returns a preview.",
      inputSchema: {
        issueKey: z.string().min(1),
        fieldsJson: z
          .string()
          .min(2)
          .describe("JSON object using the exact JPD custom field IDs."),
        confirm: z.boolean().optional(),
      },
    },
    async ({ issueKey, fieldsJson, confirm }) => {
      try {
        const fields = parseJsonObject(fieldsJson, "fieldsJson");

        const preview = requireConfirmation(
          "Update Jira Product Discovery fields",
          { issueKey, fields },
          confirm,
        );

        if (preview) return preview;

        await atlassianRequest(
          env,
          `/rest/api/3/issue/${encodeURIComponent(issueKey.trim())}`,
          {
            method: "PUT",
            body: JSON.stringify({ fields }),
          },
        );

        return textResult({
          executed: true,
          issueKey,
          url: `${getSiteUrl(env)}/browse/${issueKey}`,
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



