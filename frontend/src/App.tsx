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

  // Find embedded wallet
  const embeddedWallet = wallets.find((wallet) => wallet.walletClientType === 'privy');

  // Check if wallet is already delegated
  useEffect(() => {
    if (embeddedWallet) {
      // Check if this is a delegated wallet (older Privy format)
      // Your target wallet 0xA835a93b72B1d3d5E1850cB68dB9B4CDad1dCc0A is already delegated
      const isDelegatedWallet = embeddedWallet.address === '0xA835a93b72B1d3d5E1850cB68dB9B4CDad1dCc0A';
      setWalletDelegated(isDelegatedWallet);
      
      if (isDelegatedWallet) {
        console.log('Detected delegated wallet:', embeddedWallet.address);
      }
    }
  }, [embeddedWallet]);

  // Early return after all hooks are called
  if (!ready) return <div>Loading...</div>;

  // Add session signer to the wallet
  const addSessionSigner = async () => {
    if (!embeddedWallet) {
      setResponse('❌ No embedded wallet found');
      return false;
    }

    try {
      console.log('Adding session signer to wallet:', embeddedWallet.address);
      
      // For delegated wallets, check if delegation is needed
      if (embeddedWallet.address === '0xA835a93b72B1d3d5E1850cB68dB9B4CDad1dCc0A') {
        if (!walletDelegated) {
          console.log('Delegating wallet for server-side access...');
          setResponse('🔄 Delegating wallet for server-side access...');
          
          await delegateWallet({
            address: embeddedWallet.address,
            chainType: 'ethereum'
          });
          
          console.log('Wallet delegated successfully');
          setWalletDelegated(true);
          setResponse('✅ Wallet delegated for server-side access');
        } else {
          console.log('Wallet is already delegated, skipping delegation step');
          setResponse('✅ Wallet is already delegated for server-side access');
        }
      }
      
      // Add the session signer using the QUORUM_ID
      console.log('Adding session signer...');
      setResponse('🔄 Adding session signer...');
      
      await addSessionSigners({
        address: embeddedWallet.address,
        signers: [{
          signerId: 'lwa2frbis5i890hz7r63vv8f', // QUORUM_ID from backend
          policyIds: [] // No policy restrictions for now
        }]
      });

      console.log('Session signer added successfully');
      setSessionSignerAdded(true);
      setResponse('✅ Session signer added to wallet');
      return true;
    } catch (error) {
      console.error('Error adding session signer:', error);
      setResponse(`❌ Error adding session signer: ${error}`);
      return false;
    }
  };

  const connectToMCP = async () => {
    // First, add session signer if not already added
    if (!sessionSignerAdded) {
      const success = await addSessionSigner();
      if (!success) {
        return; // Exit if session signer couldn't be added
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
    if (!embeddedWallet) {
      setResponse('❌ No embedded wallet found');
      return;
    }

    try {
      // Check if wallet is ready for signing
      console.log('Checking wallet readiness...');
      
      // Try to get the wallet provider to ensure it's ready
      const provider = await embeddedWallet.getEthereumProvider();
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
      setResponse(`❌ Error preparing wallet: ${error}`);
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
          <p>Wallet Delegation Status: {walletDelegated ? '✅ Delegated' : '❌ Not delegated'}</p>
          <p>Session Signer Status: {sessionSignerAdded ? '✅ Added' : '❌ Not added'}</p>
          
          <div style={{ marginTop: '10px', marginBottom: '10px' }}>
            <button onClick={addSessionSigner} disabled={sessionSignerAdded}>
              {walletDelegated ? 'Add Session Signer' : 'Delegate Wallet & Add Session Signer'}
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