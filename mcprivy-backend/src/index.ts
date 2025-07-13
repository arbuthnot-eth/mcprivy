import { PrivyClient } from '@privy-io/server-auth';
import { generateAuthorizationSignature } from '@privy-io/server-auth/wallet-api';

interface Env {
  PRIVY_APP_ID: string;
  PRIVY_APP_SECRET: string;
}

interface WebSocketState {
  walletId: string;
  privateKeyHex: string;
}

const wsState = new Map<WebSocket, WebSocketState>();

// Helper function to convert base64 to hex (Cloudflare Workers compatible)
function base64ToHex(base64: string): string {
  const binary = atob(base64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    const byte = binary.charCodeAt(i);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// Helper function to convert ArrayBuffer to base64
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    
    // Handle WebSocket connections at /ws route
    if (url.pathname === '/ws') {
      try {
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
          return new Response('Expected websocket', { status: 400 });
        }

        const token = url.searchParams.get('token');
        if (!token) {
          return new Response('Token required', { status: 401 });
        }

        console.log('Creating WebSocket pair...');
        const pair = new WebSocketPair();
        const clientWs = pair[0];
        const serverWs = pair[1];

        serverWs.accept();
        console.log('WebSocket connection established!');
        
        // Send a welcome message
        serverWs.send(JSON.stringify({
          id: 'welcome',
          message: 'Connected to MCPrivy server! Minimal test version.',
          jsonrpc: '2.0'
        }));

        serverWs.addEventListener('message', async (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            console.log('Received message:', msg);
            
            // Echo the message back
            serverWs.send(JSON.stringify({
              id: msg.id,
              result: `Echo: ${JSON.stringify(msg)}`,
              jsonrpc: '2.0'
            }));
          } catch (error) {
            console.error('Message handling error:', error);
            serverWs.send(JSON.stringify({ 
              id: 1, 
              error: 'Message parse error', 
              jsonrpc: '2.0' 
            }));
          }
        });

        serverWs.addEventListener('close', () => {
          console.log('WebSocket connection closed');
        });

        serverWs.addEventListener('error', (error) => {
          console.error('WebSocket error:', error);
        });

        return new Response(null, { status: 101, webSocket: clientWs });
      } catch (error) {
        console.error('WebSocket setup error:', error);
        return new Response(`Internal server error: ${error}`, { status: 500 });
      }
    }

    // Handle other routes - let the static assets be served
    return new Response('Not found', { status: 404 });
  },
};