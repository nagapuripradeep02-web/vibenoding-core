import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

// Helper to get user ID from headers
function getUserId(req: Request): string | null {
  const userId = req.headers['x-user-id'];
  if (typeof userId === 'string' && userId.length > 0) {
    return userId;
  }
  return null;
}

// Helper to omit api_key_encrypted from connection object
function omitApiKey<T extends { api_key_encrypted?: unknown }>(connection: T): Omit<T, 'api_key_encrypted'> {
  const { api_key_encrypted, ...rest } = connection;
  return rest;
}

// GET /api/v1/n8n/connections - List all connections for a user
router.get('/connections', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  
  if (!userId) {
    return res.status(401).json({ error: 'Missing x-user-id header' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('n8n_connections')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Remove api_key from each connection
    const connections = (data || []).map(omitApiKey);
    res.json(connections);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// POST /api/v1/n8n/connections - Create a new connection
router.post('/connections', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  
  if (!userId) {
    return res.status(401).json({ error: 'Missing x-user-id header' });
  }

  const { label, baseUrl, apiKey } = req.body;

  // Validate required fields
  if (!label || typeof label !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid field: label' });
  }
  if (!baseUrl || typeof baseUrl !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid field: baseUrl' });
  }
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid field: apiKey' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('n8n_connections')
      .insert({
        user_id: userId,
        name: label,
        base_url: baseUrl,
        api_key_encrypted: apiKey,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Return created connection without api_key
    res.status(201).json(omitApiKey(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// PATCH /api/v1/n8n/connections/:id - Update a connection
router.patch('/connections/:id', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  
  if (!userId) {
    return res.status(401).json({ error: 'Missing x-user-id header' });
  }

  const { id } = req.params;
  const { label, baseUrl, apiKey } = req.body;

  // Build update object with only provided fields
  const updates: Record<string, string> = {};
  if (label && typeof label === 'string') updates.name = label;
  if (baseUrl && typeof baseUrl === 'string') updates.base_url = baseUrl;
  if (apiKey && typeof apiKey === 'string') updates.api_key_encrypted = apiKey;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('n8n_connections')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    res.json(omitApiKey(data));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

// GET /api/v1/n8n/connections/:id/workflows - Get workflows from user's n8n instance
router.get('/connections/:id/workflows', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  
  if (!userId) {
    return res.status(401).json({ error: 'Missing x-user-id header' });
  }

  const { id } = req.params;

  try {
    // Fetch the connection from Supabase
    const { data: connection, error } = await supabaseAdmin
      .from('n8n_connections')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error || !connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    const { base_url, api_key_encrypted } = connection;

    // Build the n8n API URL (use /api/v1 for n8n Cloud and newer versions)
    const n8nUrl = `${base_url.replace(/\/$/, '')}/api/v1/workflows`;

    console.log('Calling n8n API:', n8nUrl);

    // Call the n8n REST API
    const n8nResponse = await fetch(n8nUrl, {
      method: 'GET',
      headers: {
        'X-N8N-API-KEY': api_key_encrypted,
        'Accept': 'application/json',
      },
    });

    console.log('n8n response status:', n8nResponse.status);

    if (!n8nResponse.ok) {
      console.error(`n8n API error: ${n8nResponse.status} ${n8nResponse.statusText}`);
      return res.status(502).json({ 
        error: 'Failed to fetch workflows from n8n instance',
        details: `n8n returned status ${n8nResponse.status}`
      });
    }

    const n8nData = await n8nResponse.json() as { data?: unknown[] };

    // Return workflows array
    res.json({ workflows: n8nData.data || [] });
  } catch (error) {
    console.error('Error fetching n8n workflows:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(502).json({ 
      error: 'Failed to connect to n8n instance',
      details: message
    });
  }
});

export default router;

