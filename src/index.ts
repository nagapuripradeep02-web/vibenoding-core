import 'dotenv/config';
import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { supabaseAdmin } from './lib/supabase';
import n8nRoutes from './routes/n8n';
import v3Routes from './routes/v3';
import { listWorkflows } from './n8n';

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware
app.use(express.json());

// CORS middleware for browser requests
app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-user-id, X-VIBE-SIGNATURE');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Helper: Get n8n connection from Supabase
interface ConnectionResult {
  connection?: { base_url: string; api_key_encrypted: string };
  error?: { status: number; message: string };
}

async function getN8nConnection(connectionId?: string): Promise<ConnectionResult> {
  try {
    let query = supabaseAdmin
      .from('n8n_connections')
      .select('*');

    if (connectionId) {
      // Fetch specific connection by ID
      console.log('Fetching connection by ID:', connectionId);
      query = query.eq('id', connectionId);
    } else {
      // Fetch the most recent connection
      console.log('Fetching most recent connection');
      query = query.order('created_at', { ascending: false });
    }

    const { data: connection, error: dbError } = await query.limit(1).single();

    if (dbError) {
      console.error('Database error fetching connection:', dbError);
      return { 
        error: { 
          status: 404, 
          message: connectionId ? `Connection not found: ${dbError.message}` : `No n8n connection found: ${dbError.message}` 
        } 
      };
    }

    if (!connection) {
      console.error('No connection data returned from database');
      return { 
        error: { 
          status: 404, 
          message: connectionId ? 'Connection not found' : 'No n8n connection found' 
        } 
      };
    }

    if (!connection.base_url || !connection.api_key_encrypted) {
      console.error('Connection missing required fields:', { 
        hasBaseUrl: !!connection.base_url, 
        hasApiKey: !!connection.api_key_encrypted 
      });
      return { 
        error: { 
          status: 400, 
          message: 'Connection is missing required fields (base_url or api_key_encrypted)' 
        } 
      };
    }

    console.log('Successfully fetched connection:', { 
      id: connection.id, 
      baseUrl: connection.base_url 
    });
    return { connection: { base_url: connection.base_url, api_key_encrypted: connection.api_key_encrypted } };
  } catch (error) {
    console.error('Unexpected error in getN8nConnection:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { 
      error: { 
        status: 500, 
        message: `Failed to fetch connection: ${message}` 
      } 
    };
  }
}

// Helper: Fetch workflow from n8n using Supabase connection
interface FetchWorkflowResult {
  workflow?: unknown;
  error?: { status: number; message: string; details?: string };
}

async function fetchN8nWorkflow(workflowId: string, connectionId?: string): Promise<FetchWorkflowResult> {
  const connResult = await getN8nConnection(connectionId);

  if (connResult.error) {
    return { error: connResult.error };
  }

  const { base_url, api_key_encrypted } = connResult.connection!;

  // Call n8n API /api/v1/workflows/:id
  const n8nUrl = `${base_url.replace(/\/$/, '')}/api/v1/workflows/${workflowId}`;

  const n8nResponse = await fetch(n8nUrl, {
    method: 'GET',
    headers: {
      'X-N8N-API-KEY': api_key_encrypted,
      'Accept': 'application/json',
    },
  });

  if (!n8nResponse.ok) {
    if (n8nResponse.status === 404) {
      return { error: { status: 404, message: 'Workflow not found' } };
    }
    return {
      error: {
        status: 502,
        message: 'Failed to fetch workflow from n8n',
        details: `n8n returned status ${n8nResponse.status}`,
      },
    };
  }

  const workflow = await n8nResponse.json();
  return { workflow };
}

// Helper: List workflows from n8n connection
interface SimplifiedWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListWorkflowsResult {
  workflows?: SimplifiedWorkflow[];
  error?: { status: number; message: string; details?: string };
}

async function listN8nWorkflows(connectionId: string): Promise<ListWorkflowsResult> {
  try {
    const connResult = await getN8nConnection(connectionId);

    if (connResult.error) {
      return { error: connResult.error };
    }

    const { base_url, api_key_encrypted } = connResult.connection!;

    // Call n8n API GET /api/v1/workflows
    const n8nUrl = `${base_url.replace(/\/$/, '')}/api/v1/workflows`;

    console.log('Fetching workflows from n8n:', n8nUrl);

    const n8nResponse = await fetch(n8nUrl, {
      method: 'GET',
      headers: {
        'X-N8N-API-KEY': api_key_encrypted,
        'Accept': 'application/json',
      },
    });

    console.log('n8n response status:', n8nResponse.status);

    if (!n8nResponse.ok) {
      const errorText = await n8nResponse.text().catch(() => 'Unknown error');
      console.error('n8n API error:', n8nResponse.status, errorText);
      return {
        error: {
          status: 502,
          message: 'Failed to fetch workflows from n8n',
          details: `n8n returned status ${n8nResponse.status}: ${errorText}`,
        },
      };
    }

    const data = await n8nResponse.json() as unknown[] | { data?: unknown[] };
    
    // Handle both array response and { data: [...] } response format
    const workflowsArray = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
    
    // Map to simplified format
    const simplified: SimplifiedWorkflow[] = workflowsArray.map((wf: any) => ({
      id: String(wf.id || ''),
      name: String(wf.name || ''),
      active: Boolean(wf.active),
      createdAt: wf.createdAt ? String(wf.createdAt) : '',
      updatedAt: wf.updatedAt ? String(wf.updatedAt) : '',
    }));

    console.log(`Successfully fetched ${simplified.length} workflows`);
    return { workflows: simplified };
  } catch (error) {
    console.error('Error in listN8nWorkflows:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      error: {
        status: 500,
        message: 'Failed to fetch workflows from n8n',
        details: message,
      },
    };
  }
}

// Helper: Analyze workflow with OpenAI
interface WorkflowAnalysis {
  workflowId: string;
  name: string;
  summary: string;
  triggers: string[];
  externalServices: string[];
  credentialsNeeded: string[];
  dataSources: string[];
  completionChecklist: string[];
}

interface AnalyzeWorkflowResult {
  analysis?: WorkflowAnalysis;
  error?: { status: number; message: string; details?: string };
}

async function analyzeWorkflowWithOpenAI(
  workflow: { id?: string; name?: string },
  workflowId: string
): Promise<AnalyzeWorkflowResult> {
  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    return { error: { status: 500, message: 'OpenAI API key not configured' } };
  }

  // Prepare the OpenAI prompt
  const systemPrompt = `You are an expert at analyzing n8n workflow automation JSON files. 
Your task is to analyze the provided n8n workflow JSON and return a structured summary.

You must respond with ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "workflowId": "the workflow id",
  "name": "the workflow name",
  "summary": "A short 1-2 sentence plain English summary of what this workflow does, written for a beginner",
  "triggers": ["human-readable description of each trigger node, e.g. 'Runs when a new calendar event is created'"],
  "externalServices": ["list of external APIs/services used, e.g. 'Cal.com API', 'Supabase', 'Gmail'"],
  "credentialsNeeded": ["names of credentials or API keys the user must connect to use this workflow"],
  "dataSources": ["databases, spreadsheets, or APIs that store/retrieve data"],
  "completionChecklist": ["concrete 1-sentence TODO items ONLY for things the user must still configure - like missing API keys, placeholder URLs, IDs that need to be filled in, or required credentials that aren't connected"]
}

Important guidelines:
- Keep the summary beginner-friendly and concise
- For triggers, describe what event starts the workflow in plain English
- For completionChecklist, only include items that require user action (placeholders, missing config, unconnected credentials)
- If everything is configured, completionChecklist can be an empty array
- Do not include general advice, only specific action items based on the workflow JSON`;

  const userPrompt = `Analyze this n8n workflow JSON and return the structured summary:

${JSON.stringify(workflow, null, 2)}`;

  // Call OpenAI
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 1500,
  });

  const responseContent = completion.choices[0]?.message?.content;

  if (!responseContent) {
    return { error: { status: 500, message: 'OpenAI returned an empty response' } };
  }

  // Parse the JSON response from OpenAI
  let analysis: WorkflowAnalysis;
  try {
    analysis = JSON.parse(responseContent);
  } catch {
    console.error('Failed to parse OpenAI response:', responseContent);
    return {
      error: {
        status: 500,
        message: 'Failed to parse OpenAI response',
        details: 'The AI returned invalid JSON',
      },
    };
  }

  // Ensure required fields exist with fallbacks
  const result: WorkflowAnalysis = {
    workflowId: analysis.workflowId || workflow.id || workflowId,
    name: analysis.name || workflow.name || 'Unknown',
    summary: analysis.summary || 'No summary available',
    triggers: analysis.triggers || [],
    externalServices: analysis.externalServices || [],
    credentialsNeeded: analysis.credentialsNeeded || [],
    dataSources: analysis.dataSources || [],
    completionChecklist: analysis.completionChecklist || [],
  };

  return { analysis: result };
}

// Health check route
app.get('/api/v1/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Database health check route
app.get('/api/v1/db/health', async (req: Request, res: Response) => {
  try {
    // Query a dummy table - if Supabase responds (even with "table not found"), 
    // the connection is working. Only network/auth errors indicate real problems.
    const { error } = await supabaseAdmin
      .from('_health_check')
      .select('*')
      .limit(1);

    // "Table not found" errors mean Supabase is reachable - connection is healthy
    if (error && !error.message.includes('Could not find')) {
      return res.status(500).json({ status: 'error', message: error.message });
    }

    res.json({ status: 'ok' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ status: 'error', message });
  }
});

// n8n routes (per-user connections from Supabase)
app.use('/api/v1/n8n', n8nRoutes);

// V3.0 Workflow State Engine routes
app.use('/api', v3Routes);

// n8n routes (using env variables or connectionId)
app.get('/api/n8n/workflows', async (req: Request, res: Response) => {
  try {
    const { connectionId } = req.query;

    console.log('GET /api/n8n/workflows - connectionId:', connectionId, 'type:', typeof connectionId);

    // If connectionId is provided, use Supabase connection
    if (connectionId && typeof connectionId === 'string' && connectionId.trim() !== '') {
      console.log('Using connectionId:', connectionId);
      const result = await listN8nWorkflows(connectionId.trim());

      if (result.error) {
        console.error('Error fetching workflows:', result.error);
        return res.status(result.error.status).json({
          error: result.error.message,
          ...(result.error.details && { details: result.error.details }),
        });
      }

      if (!result.workflows) {
        console.warn('No workflows returned from listN8nWorkflows');
        return res.json([]);
      }

      console.log(`Successfully returning ${result.workflows.length} workflows`);
      return res.json(result.workflows);
    }

    // Otherwise, use env variables (existing behavior)
    console.log('No connectionId provided, using env variables for workflows');
    const workflows = await listWorkflows();
    res.json({ workflows });
  } catch (error) {
    console.error('Unexpected error listing workflows:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;
    console.error('Error stack:', stack);
    res.status(500).json({ 
      error: 'Failed to fetch workflows from n8n', 
      details: message 
    });
  }
});

// Get single workflow
app.get('/api/n8n/workflows/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    if (!id || id.trim() === '') {
      return res.status(400).json({ error: 'Missing id parameter' });
    }

    const result = await fetchN8nWorkflow(id);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        ...(result.error.details && { details: result.error.details }),
      });
    }

    res.json(result.workflow);
  } catch (error) {
    console.error('Error getting workflow:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to fetch workflow from n8n', details: message });
  }
});

// Analyze workflow via query parameters (for frontend)
// GET /api/n8n/analyze?connectionId=...&workflowId=...
app.get('/api/n8n/analyze', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId } = req.query;

    // Validate required parameters
    if (!connectionId || !workflowId || typeof connectionId !== 'string' || typeof workflowId !== 'string') {
      return res.status(400).json({ error: 'Missing connectionId or workflowId' });
    }

    // Fetch the workflow using the specific connection
    const fetchResult = await fetchN8nWorkflow(workflowId, connectionId);

    if (fetchResult.error) {
      return res.status(fetchResult.error.status).json({
        error: fetchResult.error.message,
        ...(fetchResult.error.details && { details: fetchResult.error.details }),
      });
    }

    const workflow = fetchResult.workflow as { id?: string; name?: string };

    // Analyze the workflow with OpenAI
    const analyzeResult = await analyzeWorkflowWithOpenAI(workflow, workflowId);

    if (analyzeResult.error) {
      return res.status(analyzeResult.error.status).json({
        error: analyzeResult.error.message,
        ...(analyzeResult.error.details && { details: analyzeResult.error.details }),
      });
    }

    res.json(analyzeResult.analysis);
  } catch (error) {
    console.error('Error analyzing workflow:', error);
    res.status(500).json({ error: 'Failed to analyze workflow' });
  }
});

// Analyze workflow via path parameter (original route)
// GET /api/n8n/workflows/:id/analyze
app.get('/api/n8n/workflows/:id/analyze', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id || id.trim() === '') {
      return res.status(400).json({ error: 'Missing id parameter' });
    }

    // Fetch the workflow
    const fetchResult = await fetchN8nWorkflow(id);

    if (fetchResult.error) {
      return res.status(fetchResult.error.status).json({
        error: fetchResult.error.message,
        ...(fetchResult.error.details && { details: fetchResult.error.details }),
      });
    }

    const workflow = fetchResult.workflow as { id?: string; name?: string };

    // Analyze the workflow with OpenAI
    const analyzeResult = await analyzeWorkflowWithOpenAI(workflow, id);

    if (analyzeResult.error) {
      return res.status(analyzeResult.error.status).json({
        error: analyzeResult.error.message,
        ...(analyzeResult.error.details && { details: analyzeResult.error.details }),
      });
    }

    res.json(analyzeResult.analysis);
  } catch (error) {
    console.error('Error analyzing workflow:', error);

    // Check for OpenAI-specific errors
    if (error instanceof OpenAI.APIError) {
      return res.status(500).json({
        error: 'OpenAI API error',
        details: error.message,
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to analyze workflow', details: message });
  }
});

// Helper function for chat processing
async function processChatMessage(
  connectionId: string,
  workflowId: string,
  message: string
): Promise<{ response?: string; workflowId?: string; workflowName?: string; error?: { status: number; message: string; details?: string } }> {
  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    return { error: { status: 500, message: 'OpenAI API key not configured' } };
  }

  // Fetch the workflow
  const fetchResult = await fetchN8nWorkflow(workflowId, connectionId);

  if (fetchResult.error) {
    return { error: fetchResult.error };
  }

  const workflow = fetchResult.workflow;
  const workflowName = (workflow as { name?: string })?.name || 'this workflow';
  const workflowIdValue = (workflow as { id?: string })?.id || workflowId;

  // Prepare the OpenAI prompt for conversational response (Analyze tab)
  const systemPrompt = `You are Vibe Noding’s n8n Workflow Analyst.

Your purpose:
- Help users understand what their n8n workflow does.
- Answer their specific questions about the workflow.
- Always base your answer strictly on the provided workflow JSON and metadata.

Inputs you receive (in the user message):
- A natural-language question from the user (or a generic request like “What does this workflow do?”).
- The workflow name and optional metadata (e.g., active/inactive, tags, createdAt/updatedAt).
- The full workflow JSON exported from n8n (or fetched from an n8n server).

Your goals:
1. Focus on the user’s question first.
2. Use the workflow JSON to give a clear, accurate explanation.
3. Highlight the most important behavior: triggers, external services, data sources, data sinks, and main logic.
4. Stay practical and non-technical where possible, but you may reference node names like “HTTP Request”, “Set”, “Code”, “Merge” when helpful.
5. Keep the answer compact but complete enough that a non-developer can understand what the workflow is doing at a high level.

Always include:
1) A short high-level summary.
2) A breakdown of the important parts of the workflow.
3) A final section called **“For example:”** with a simple, concrete scenario showing how the workflow runs from start to finish.

When the user asks a broad question like “What does this workflow do?”:
- Give a concise overview first (2–4 sentences).
- Then list the main steps in order:
  - Triggers (what starts the workflow).
  - Important branching logic (IF nodes, Switch, Merge, Split).
  - External services (APIs, databases, cloud storage, SaaS tools).
  - Where the data ends up (e.g. “saved into Supabase”, “sent via email”, “posted to Slack”).
- Mention key concepts like credentials, locations, tags, or environments only at a high level here; the detailed configuration checklist belongs to the Complete tab, not Analyze.

When the user asks a specific question (for example, “What does the OCR step do?” or “Where does this workflow call Supabase?”):
- Answer only what they asked, with enough context.
- Clearly reference the relevant nodes by their names or types, and describe how they fit into the overall flow.
- Do not dump the full node configuration; describe it in human language.

When there are multiple paths (for example different triggers or branches like “KITCHEN” vs “BAR”):
- Explain the separation briefly, and what each path represents.
- Tie that to the real-world meaning (e.g., “kitchen receipts vs bar receipts”).

For the “For example:” section:
- Describe a realistic, simple story of how a single run of this workflow works, step by step.
- Use friendly, plain language that a teenager or non-technical restaurant owner could understand.
- Make sure the example accurately reflects the actual workflow logic.

Important rules:
- Do not hallucinate nodes or logic that do not exist in the workflow JSON.
- If something is unclear from the JSON, say it is unclear instead of guessing.
- Do not output raw JSON or huge configuration dumps.
- Do not give step-by-step setup instructions here; that belongs in the Complete tab.
- Do not talk about being an AI model or about prompts; just answer as the workflow expert.`;

  const userPrompt = `User question:
${message}

Workflow name:
${workflowName}

Workflow JSON:
${JSON.stringify(workflow, null, 2)}`;

  // Call OpenAI for conversational response
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 2000,
  });

  const responseContent = completion.choices[0]?.message?.content;

  if (!responseContent) {
    return { error: { status: 500, message: 'OpenAI returned an empty response' } };
  }

  return {
    response: responseContent,
    workflowId: workflowIdValue,
    workflowName: workflowName
  };
}

// Helper function for completion/checklist responses (Complete tab)
async function processCompletionChecklist(
  connectionId: string,
  workflowId: string,
  question?: string
): Promise<{ response?: string; workflowId?: string; workflowName?: string; error?: { status: number; message: string; details?: string } }> {
  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    return { error: { status: 500, message: 'OpenAI API key not configured' } };
  }

  // Fetch the workflow
  const fetchResult = await fetchN8nWorkflow(workflowId, connectionId);

  if (fetchResult.error) {
    return { error: fetchResult.error };
  }

  const workflow = fetchResult.workflow;
  const workflowName = (workflow as { name?: string })?.name || 'this workflow';
  const workflowIdValue = (workflow as { id?: string })?.id || workflowId;
  const userQuestion = question && question.trim() !== '' ? question : 'Help me prepare this for production.';

  // Prepare the OpenAI prompt for the Complete tab (production readiness)
  const systemPrompt = `You are Vibe Noding’s n8n Workflow Completion Coach.

Your purpose:
- Turn a given n8n workflow into a production-ready automation.
- Tell the user EVERYTHING they must configure manually before going live.
- This includes BOTH:
  - Credentials / connections
  - Placeholders / static values
  - External service setup
  - Tests & go-live checklist

Inputs you receive in the user message:
- Workflow name and optional metadata.
- Whether it is a template/library workflow or a live workflow.
- The full workflow JSON exported from n8n.
- Optionally a short request such as “Help me complete this.”

You MUST ALWAYS perform these steps mentally:

1. Scan all nodes in the workflow JSON.
   - Look at each node’s type, name, and any credentials or connection fields.
   - Pay special attention to node types that typically require credentials or connections:
     - Databases (Postgres, MySQL, SQLite, Supabase, MongoDB, Redis, etc.).
     - HTTP / REST calls.
     - Email (IMAP, SMTP).
     - Cloud storage (S3, Supabase storage, GCS, Azure, etc.).
     - SaaS integrations (Slack, Telegram, Twilio, Google APIs, etc.).
   - Even if the workflow JSON already contains a credential name or ID, you must still mention it, telling the user to verify it is configured correctly in their own n8n.

2. Scan all nodes for placeholder or obviously dummy values.
   - Base URLs like https://example.com or http://localhost:...
   - Strings like YOUR_API_KEY_HERE, your-project-id, test@example.com, fake phone numbers, dummy bucket names, etc.
   - Any filter conditions or query strings that look like generic/test values.

3. Infer external setup that must exist for this workflow to work.
   - Webhook URLs must be registered somewhere (e.g. in VAPI, Stripe, Typeform, etc.).
   - Email inboxes must receive messages in a certain format.
   - Database tables, RPC functions or APIs (like rpc/ingest_receipt) must exist and accept the expected fields.

Your output MUST ALWAYS be structured in this order, and MUST include credentials, even if the user didn’t mention them:

1) **Overview**
   - 2–4 sentences summarizing what this workflow will do in production.

2) **Credentials & Connections to Configure**
   - This section is mandatory.
   - For EVERY node that likely needs a credential or connection, add at least one checklist item.
   - For each item, clearly state:
     - The node name and type (e.g. “Query Table Availability (Postgres) – postgres node”).
     - Which kind of credential is needed in n8n (e.g. Postgres DB credential, HTTP auth, IMAP, SMTP, Supabase, etc.).
     - What the user must do in plain language, for example:
       - “In n8n, create a Postgres credential pointing to your production database and attach it to the ‘Query Table Availability (Postgres)’ node.”
       - “Check that the HTTP Request node uses your real Supabase REST URL and a valid service role or anon key.”
   - If a credential appears to be already configured in the JSON, say “Verify that the credential ‘XYZ’ points to the correct production account.”

3) **Placeholders & Static Values to Replace**
   - List all obvious placeholders / dummy values.
   - Point to the node and field in human language:
     - “In the ‘Upsert Booking in Postgres’ node’s SQL text, replace the table name if your schema is different.”
     - “Replace YOUR_WEBHOOK_URL_HERE in the Webhook node with the actual URL from your provider.”
   - Err on the side of including more, not less.

4) **External Services & Infrastructure Setup**
   - Describe what must exist outside of n8n:
     - Database tables / schemas.
     - RPC functions or stored procedures (e.g., ingest_receipt).
     - Webhook registrations.
     - Google / cloud API enablement and keys.
   - Each item should be an actionable “To do” sentence.

5) **Workflow Logic & Data Checks**
   - Highlight conditions/assumptions the user may need to adapt:
     - Location tags (e.g., “KITCHEN”, “BAR”).
     - Status values, enums, email subjects, booking states, etc.
   - Tell the user what to review and adjust.

6) **Testing Before Going Live**
   - Give at least:
     - One “happy path” test scenario.
     - One edge-case test scenario.
   - Refer to nodes by their names when explaining what to look at in the execution log.

7) **Go-Live Checklist**
   - A small bullet list summarising:
     - “All credentials are created and attached to the correct nodes.”
     - “All placeholders are replaced with real values.”
     - “External tables/APIs/functions exist and have been tested.”
     - “The workflow has run successfully at least once with realistic test data.”
     - “The workflow is set to Active in n8n.”

Tone:
- Clear, direct, practical.
- Assume the user might be a non-developer (restaurant owner, ops manager).
- No raw JSON dumps, no internal prompt talk, no model disclaimers.

If you are unsure about a detail, say “Check that …” instead of inventing it.
Always include a “Credentials & Connections to Configure” section. Never omit it, even if the workflow looks fully wired.`;

  const userPrompt = `Workflow name:
${workflowName}

User request/context:
${userQuestion}

Workflow JSON:
${JSON.stringify(workflow, null, 2)}`;

  // Call OpenAI for completion/checklist response
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 2200,
  });

  const responseContent = completion.choices[0]?.message?.content;

  if (!responseContent) {
    return { error: { status: 500, message: 'OpenAI returned an empty response' } };
  }

  return {
    response: responseContent,
    workflowId: workflowIdValue,
    workflowName: workflowName
  };
}

// Chat endpoint for asking questions about workflows
// POST /api/n8n/chat
// Body: { connectionId: string, workflowId: string, message: string }
app.post('/api/n8n/chat', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId, message } = req.body;

    // Validate required parameters
    if (!connectionId || !workflowId || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: 'connectionId, workflowId, and message are required' 
      });
    }

    if (typeof connectionId !== 'string' || typeof workflowId !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'All fields must be strings' });
    }

    if (message.trim() === '') {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    console.log('Chat request (POST):', { connectionId, workflowId, messageLength: message.length });

    const result = await processChatMessage(connectionId, workflowId, message);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        ...(result.error.details && { details: result.error.details }),
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error in chat endpoint:', error);

    // Check for OpenAI-specific errors
    if (error instanceof OpenAI.APIError) {
      return res.status(500).json({
        error: 'OpenAI API error',
        details: error.message,
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to process chat message', 
      details: message 
    });
  }
});

// Chat endpoint via GET (for convenience)
// GET /api/n8n/chat?connectionId=...&workflowId=...&message=...
app.get('/api/n8n/chat', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId, message } = req.query;

    // Validate required parameters
    if (!connectionId || !workflowId || !message) {
      return res.status(400).json({ 
        error: 'Missing required query parameters',
        details: 'connectionId, workflowId, and message are required' 
      });
    }

    if (typeof connectionId !== 'string' || typeof workflowId !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'All parameters must be strings' });
    }

    if (message.trim() === '') {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    console.log('Chat request (GET):', { connectionId, workflowId, messageLength: message.length });

    const result = await processChatMessage(connectionId, workflowId, message);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        ...(result.error.details && { details: result.error.details }),
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error in chat endpoint:', error);

    // Check for OpenAI-specific errors
    if (error instanceof OpenAI.APIError) {
      return res.status(500).json({
        error: 'OpenAI API error',
        details: error.message,
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to process chat message', 
      details: message 
    });
  }
});

// Complete tab endpoint (production readiness checklist)
// POST /api/n8n/complete
// Body: { connectionId: string, workflowId: string, question?: string }
app.post('/api/n8n/complete', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId, question } = req.body;

    if (!connectionId || !workflowId) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'connectionId and workflowId are required',
      });
    }

    if (typeof connectionId !== 'string' || typeof workflowId !== 'string') {
      return res.status(400).json({ error: 'connectionId and workflowId must be strings' });
    }

    console.log('Complete request (POST):', { connectionId, workflowId });

    const result = await processCompletionChecklist(connectionId, workflowId, question);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        ...(result.error.details && { details: result.error.details }),
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error in complete endpoint:', error);

    if (error instanceof OpenAI.APIError) {
      return res.status(500).json({
        error: 'OpenAI API error',
        details: error.message,
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      error: 'Failed to process completion checklist',
      details: message,
    });
  }
});

// GET /api/n8n/complete?connectionId=...&workflowId=...&question=...
app.get('/api/n8n/complete', async (req: Request, res: Response) => {
  try {
    const { connectionId, workflowId, question } = req.query;

    if (!connectionId || !workflowId) {
      return res.status(400).json({
        error: 'Missing required query parameters',
        details: 'connectionId and workflowId are required',
      });
    }

    if (typeof connectionId !== 'string' || typeof workflowId !== 'string') {
      return res.status(400).json({ error: 'connectionId and workflowId must be strings' });
    }

    console.log('Complete request (GET):', { connectionId, workflowId });

    const result = await processCompletionChecklist(connectionId, workflowId, typeof question === 'string' ? question : undefined);

    if (result.error) {
      return res.status(result.error.status).json({
        error: result.error.message,
        ...(result.error.details && { details: result.error.details }),
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error in complete endpoint:', error);

    if (error instanceof OpenAI.APIError) {
      return res.status(500).json({
        error: 'OpenAI API error',
        details: error.message,
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({
      error: 'Failed to process completion checklist',
      details: message,
    });
  }
});

// Simple health check (root level)
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
