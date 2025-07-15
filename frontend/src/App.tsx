import { usePrivy, useWallets, useSessionSigners, useHeadlessDelegatedActions, type WalletWithMetadata } from '@privy-io/react-auth';
import { useState, useEffect } from 'react';

function App() {
  const { ready, authenticated, login, logout, getAccessToken, user } = usePrivy();
  const { wallets } = useWallets();
  const { addSessionSigners, removeSessionSigners } = useSessionSigners();
  const { delegateWallet } = useHeadlessDelegatedActions();
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [response, setResponse] = useState('');
  const [token, setToken] = useState('');
  const [sessionSignerAdded, setSessionSignerAdded] = useState(false);
  const [walletDelegated, setWalletDelegated] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

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
      // Check if the wallet is delegated or has session signers
      const isDelegated = user?.linkedAccounts.some(
        (account) => account.type === 'wallet' && account.address === activeWallet.address && account.delegated
      );
      if (isDelegated) {
        connectToMCP();
      }
    }
  }, [activeWallet, user]);

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

  // Function to revoke server access (remove session signers)
  const revokeServerAccess = async () => {
    const delegatedWallet = user?.linkedAccounts.find(
      (account) => account.type === 'wallet' && account.delegated
    ) as WalletWithMetadata | undefined;

    if (!delegatedWallet) return;

    try {
      console.log('Revoking server access for wallet:', delegatedWallet.address);
      setResponse(`🔄 Revoking server access for wallet: ${delegatedWallet.address}...`);
      await removeSessionSigners({ address: delegatedWallet.address });
      // Update the state to reflect that the wallet is no longer delegated
      setWalletDelegated(false);
      setSessionSignerAdded(false);
      setResponse('✅ Server access permission revoked successfully');
    } catch (error) {
      console.error('Error removing session signer:', error);
      setResponse(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const connectToMCP = async () => {
    if (!isConnected) {
      const token = await getAccessToken();
      // Updated URL to use /ws route
      const url = import.meta.env.VITE_WORKER_WS_URL + `?token=${token}`;
      const socket = new WebSocket(url);
      socket.onopen = () => {
        console.log('WS connected');
        setResponse('✅ Connected to MCP Server');
        setIsConnected(true);
      };
      socket.onmessage = (event) => {
        setResponse(event.data);
        console.log('Received:', event.data);
      };
      socket.onclose = () => {
        console.log('WS closed');
        setResponse('❌ Connection closed');
        setIsConnected(false);
      };
      socket.onerror = (error) => {
        console.error('WS error:', error);
        setResponse('❌ Connection error');
        setIsConnected(false);
      };
      setWs(socket);
    }

    if (activeWallet) {
      // Check if the wallet is delegated or has session signers
      const isDelegated = user?.linkedAccounts.some(
        (account) => account.type === 'wallet' && account.address === activeWallet.address && account.delegated
      );
      if (!isDelegated) {
            // First, grant server access if not already done
        if (!sessionSignerAdded && !walletDelegated) {
          const success = await grantServerAccess();
          if (!success) {
            return; // Exit if access couldn't be granted
          }
        }
      }
      else {
        setWalletDelegated(!!isDelegated);
        setSessionSignerAdded(!!isDelegated);
      }
    }

    
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

      // Check if wallet has the required session signer
      const quorumId = import.meta.env.VITE_QUORUM_ID;
      if (!quorumId) {
        setResponse('❌ Quorum ID not configured');
        return;
      }

      // For embedded wallets, check if session signer exists
      if (activeWallet.walletClientType === 'privy') {
        const hasRequiredSigner = user?.linkedAccounts.some(account => {
          if (account.type === 'wallet' && account.address === activeWallet.address) {
            // Check if the account is delegated or has the required session signer
            setWalletDelegated(account.delegated);
            return account.delegated;
          }
          return false;
        });

        if (!hasRequiredSigner) {
          setResponse('❌ Wallet does not have the required session signer');
          console.log('Server access permission required for this action');
          return;
        }
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
          <p style={{ marginBottom: '10px' }}>Server Access Status: {sessionSignerAdded || walletDelegated ? '✅ Granted' : '❌ Not granted'}</p>

          <div style={{ marginTop: '10px', marginBottom: '10px' }}>
            <button onClick={connectToMCP} disabled={sessionSignerAdded || walletDelegated}>
              Grant Server Access Permission
            </button>
            <button onClick={revokeServerAccess} disabled={!sessionSignerAdded && !walletDelegated}>
              Revoke Server Access Permission
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