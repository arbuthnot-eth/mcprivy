import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useState, useEffect } from 'react';

function App() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [response, setResponse] = useState('');
  const [token, setToken] = useState('');

  // Get token when authenticated
  useEffect(() => {
    if (authenticated) {
      getAccessToken().then(t => t && setToken(t));
    }
  }, [authenticated, getAccessToken]);

  if (!ready) return <div>Loading...</div>;

  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === 'privy');

  const connectToMCP = async () => {
    const token = await getAccessToken();
    // Updated URL to use /ws route
    const url = `wss://mcprivy-backend.imbibed.workers.dev/ws?token=${token}`;
    const socket = new WebSocket(url);
    socket.onopen = () => {
      console.log('WS connected');
      setResponse('✅ Connected to MCP Server');
    };
    socket.onmessage = (event) => {
      setResponse(event.data);
      console.log('Received:', event.data);
    };
    socket.onclose = () => {
      console.log('WS closed');
      setResponse('❌ Connection closed');
    };
    socket.onerror = (error) => {
      console.error('WS error:', error);
      setResponse('❌ Connection error');
    };
    setWs(socket);
  };

  const sendSignRequest = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const rpcRequest = {
        id: 1,
        jsonrpc: '2.0',
        method: 'signPersonalMessage',
        params: ['0x48656c6c6f20776f726c64'], // Hex for "Hello world"
      };
      ws.send(JSON.stringify(rpcRequest));
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>MCPrivy Frontend</h1>
      {!authenticated ? (
        <button onClick={login}>Login with Privy</button>
      ) : (
        <div>
          <button onClick={logout}>Logout</button>
          <p>Embedded Wallet Address: {embeddedWallet?.address || 'No wallet provisioned'}</p>
          <p>Token: {token}</p>
          <button onClick={connectToMCP}>Connect to MCP Server</button>
          <br />
          <button onClick={sendSignRequest}>Send signPersonalMessage Request</button>
          <p>Response: {response}</p>
        </div>
      )}
    </div>
  );
}

export default App;