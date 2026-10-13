const ENDPOINT = "https://api.linear.app/graphql";

export class LinearApiError extends Error {
  constructor(
    message: string,
    readonly errors: Array<{ message: string; extensions?: Record<string, unknown> }> = [],
  ) {
    super(message);
    this.name = "LinearApiError";
  }
  get notFound(): boolean {
    return this.errors.some(
      (e) => /not found|could not find/i.test(e.message) || e.extensions?.code === "ENTITY_NOT_FOUND",
    );
  }
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
  /** ISO timestamp; used to spot a read that is older than the webhook that triggered it. */
  updatedAt: string;
  /** Deleted issues sit in the trash (and are still readable) for 30 days. */
  trashed?: boolean | null;
  state: { id: string; name: string; type: string };
  labels: { nodes: Array<{ id: string }> };
}

const ISSUE_FIELDS = `id identifier url updatedAt trashed state { id name type } labels { nodes { id } }`;

export interface CreateIssueInput {
  id: string;
  teamId: string;
  stateId: string;
  title: string;
  description: string;
  labelIds: string[];
}

export class LinearClient {
  constructor(private readonly apiKey: string) {}

  /** Returns null when the issue does not exist (never created, or deleted). */
  async getIssue(id: string): Promise<LinearIssue | null> {
    try {
      const data = await this.gql<{ issue: LinearIssue | null }>(
        `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id },
      );
      return data.issue;
    } catch (err) {
      if (err instanceof LinearApiError && err.notFound) return null;
      throw err;
    }
  }

  /** Current state and labels for many issues in one request (at most 50 IDs). */
  async getIssues(ids: string[]): Promise<LinearIssue[]> {
    if (ids.length === 0) return [];
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query Issues($ids: [ID!]!) { issues(filter: { id: { in: $ids } }, first: 50) { nodes { ${ISSUE_FIELDS} } } }`,
      { ids },
    );
    return data.issues.nodes;
  }

  async createIssue(input: CreateIssueInput): Promise<LinearIssue> {
    const data = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
      }`,
      { input },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new LinearApiError("issueCreate was not successful");
    return data.issueCreate.issue;
  }

  async linkUrl(issueId: string, url: string, title: string): Promise<void> {
    await this.gql(
      `mutation Link($issueId: String!, $url: String!, $title: String) {
        attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
      }`,
      { issueId, url, title },
    );
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.gql(
      `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
  }

  async prepareUpload(file: { filename: string; contentType: string; size: number }): Promise<{
    uploadUrl: string;
    assetUrl: string;
    headers: Array<{ key: string; value: string }>;
  }> {
    const data = await this.gql<{
      fileUpload: {
        success: boolean;
        uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null;
      };
    }>(
      `mutation Upload($filename: String!, $contentType: String!, $size: Int!) {
        fileUpload(filename: $filename, contentType: $contentType, size: $size) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      file,
    );
    if (!data.fileUpload.success || !data.fileUpload.uploadFile) throw new LinearApiError("fileUpload was not successful");
    return data.fileUpload.uploadFile;
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let body: { data?: T; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };
    try {
      body = JSON.parse(text);
    } catch {
      throw new LinearApiError(`Linear API ${res.status}: ${text.slice(0, 300)}`);
    }
    if (body.errors?.length) {
      throw new LinearApiError(`Linear API: ${body.errors.map((e) => e.message).join("; ")}`, body.errors);
    }
    if (!res.ok || !body.data) throw new LinearApiError(`Linear API ${res.status}: ${text.slice(0, 300)}`);
    return body.data;
  }
}
