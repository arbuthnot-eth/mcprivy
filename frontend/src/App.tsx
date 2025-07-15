import { usePrivy, useWallets, useSessionSigners, useHeadlessDelegatedActions } from '@privy-io/react-auth';
import { useState, useEffect } from 'react';

function App() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { addSessionSigners } = useSessionSigners();
  const { delegateWallet } = useHeadlessDelegatedActions();
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [response, setResponse] = useState('');
  const [token, setToken] = useState('');
  const [sessionSignerAdded, setSessionSignerAdded] = useState(false);
  const [walletDelegated, setWalletDelegated] = useState(false);

  // Get token when authenticated
  useEffect(() => {
    if (authenticated) {
      getAccessToken().then(t => t && setToken(t));
    }
  }, [authenticated, getAccessToken]);

  // Find the active wallet (embedded or external)
  const activeWallet = wallets[0]; // Assume first wallet; adjust if multiple

  // Check if wallet is already delegated or has session signer
  useEffect(() => {
    if (activeWallet) {
      // For simplicity, check if it's delegated (expand as needed)
      const isDelegated = activeWallet.address === '0xA835a93b72B1d3d5E1850cB68dB9B4CDad1dCc0A'; // Your hardcoded check; remove if not needed
      setWalletDelegated(isDelegated);
      
      // TODO: Query Privy API or dashboard to check if quorum is already added as signer
    }
  }, [activeWallet]);

  // Add session signer (for embedded wallets) or delegate (for external/client-side)
  const grantServerAccess = async () => {
    if (!activeWallet) {
      setResponse('❌ No wallet found');
      return false;
    }

    try {
      console.log('Granting server access for wallet:', activeWallet.address);
      setResponse('🔄 Requesting permission for server access...');

      // Retrieve quorum ID from .env (do not hard-code)
      const quorumId = import.meta.env.VITE_QUORUM_ID;
      if (!quorumId) {
        throw new Error('Quorum ID not found in .env');
      }

      if (activeWallet.walletClientType === 'privy') {
        // Embedded wallet: Add session signer (prompts user if policies require confirmation)
        // Add policyIds: [] (or your policy IDs if configured)
        try {
          await addSessionSigners({
            address: activeWallet.address,
            signers: [{ signerId: quorumId, policyIds: [] }]
          });
          setSessionSignerAdded(true);
          setResponse('✅ Permission granted: Session signer added (embedded wallet)');
        } catch (error) {
          // Handle duplicate or quorum error
          const privyError = error as { response?: { status: number } };
          if (error instanceof Error && (error.message.includes('r23') || (privyError.response?.status === 400))) {
            console.log('Signer may already be added or quorum validated');
            setSessionSignerAdded(true);
            setResponse('✅ Signer already added or quorum validated');
            return true;
          } else {
            throw error;
          }
        }
      } else {
        // External/client-side wallet: Delegate for server-side access (prompts user for permission)
        await delegateWallet({
          address: activeWallet.address,
          chainType: 'ethereum' // Adjust for other chains if needed
        });
        setWalletDelegated(true);
        setResponse('✅ Permission granted: Wallet delegated for server-side access');
      }
      return true;
    } catch (error) {
      console.error('Error granting access:', error);
      setResponse(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const connectToMCP = async () => {
    // First, grant server access if not already done
    if (!sessionSignerAdded && !walletDelegated) {
      const success = await grantServerAccess();
      if (!success) {
        return; // Exit if access couldn't be granted
      }
    }

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

  const sendSignRequest = async () => {
    if (!activeWallet) {
      setResponse('❌ No wallet found');
      return;
    }

    try {
      // Check if wallet is ready for signing
      console.log('Checking wallet readiness...');
      
      // Try to get the wallet provider to ensure it's ready
      const provider = await activeWallet.getEthereumProvider();
      if (!provider) {
        setResponse('❌ Wallet provider not available');
        return;
      }
      
      console.log('Wallet provider ready, attempting to sign...');
      
      // Now try to sign via WebSocket
      if (ws && ws.readyState === WebSocket.OPEN) {
        const rpcRequest = {
          id: 1,
          jsonrpc: '2.0',
          method: 'signPersonalMessage',
          params: ['0x48656c6c6f20776f726c64'], // Hex for "Hello world"
        };
        ws.send(JSON.stringify(rpcRequest));
      }
    } catch (error) {
      console.error('Error preparing wallet for signing:', error);
      setResponse(`❌ Error preparing wallet: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (!ready) return <div>Loading...</div>;

  return (
    <div style={{ padding: '20px' }}>
      <h1>MCPrivy Frontend</h1>
      {!authenticated ? (
        <button onClick={login}>Login with Privy</button>
      ) : (
        <div>
          <button onClick={logout}>Logout</button>
          <p>Wallet Address: {activeWallet?.address || 'No wallet provisioned'}</p>
          <p>Wallet Type: {activeWallet?.walletClientType || 'Unknown'}</p>
          <p>Token: {token}</p>
          <p>Server Access Status: {sessionSignerAdded || walletDelegated ? '✅ Granted' : '❌ Not granted'}</p>
          
          <div style={{ marginTop: '10px', marginBottom: '10px' }}>
            <button onClick={grantServerAccess} disabled={sessionSignerAdded || walletDelegated}>
              Grant Server Access Permission
            </button>
            <button onClick={connectToMCP} style={{ marginLeft: '10px' }}>
              Connect to MCP Server
            </button>
          </div>
          
          <button onClick={sendSignRequest}>Send signPersonalMessage Request</button>
          <br />
          <div style={{ marginTop: '10px', fontSize: '14px', color: '#666' }}>
            <p><strong>Note:</strong> For delegated wallets (older Privy format), the wallet must first be delegated for server-side access.</p>
            <p>Then, session signers are added to allow the server to sign transactions on behalf of your wallet.</p>
            <p>You need to complete both steps before the wallet can sign transactions via the MCP server.</p>
          </div>
          <p>Response: {response}</p>
        </div>
      )}
    </div>
  );
}

export default App;