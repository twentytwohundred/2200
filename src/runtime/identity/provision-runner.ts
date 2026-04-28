/**
 * Production glue between the ProvisioningPipeline and the OpenSCUT
 * register service (Epic 4 Phase A v0.4).
 *
 * Loads the master key, constructs a register client (default
 * https://register.openscut.ai, override via OPENSCUT_REGISTER_URL),
 * and runs the pipeline against the named Agent.
 *
 * Tests use ProvisioningPipeline directly with injected fakes; this
 * module is the production wiring.
 */
import { agentPaths } from '../storage/layout.js'
import { loadIdentity, writeIdentity } from './loader.js'
import { generateAgentKeypairs, loadOrCreateMasterKey, writeAgentKeys } from './keystore.js'
import {
  createRegisterClient,
  DEFAULT_REGISTER_BASE_URL,
  type RegisterClient,
} from './register-client.js'
import { ProvisioningPipeline, type IdentityWriter } from './provisioning.js'

export interface ProvisionRunArgs {
  home: string
  agentName: string
  /** Override the OpenSCUT register URL. Defaults to OPENSCUT_REGISTER_URL env, then DEFAULT_REGISTER_BASE_URL. */
  registerBaseUrl?: string
  /** Test injection. */
  registerClient?: RegisterClient
}

export interface ProvisionRunResult {
  uri: string
  tokenId: string
  mintTx: string
  updateTx: string
}

export async function runIdentityProvisionFromConfig(
  args: ProvisionRunArgs,
): Promise<ProvisionRunResult> {
  const masterKey = await loadOrCreateMasterKey(args.home)
  const registerClient =
    args.registerClient ??
    createRegisterClient({
      baseUrl:
        args.registerBaseUrl ?? process.env['OPENSCUT_REGISTER_URL'] ?? DEFAULT_REGISTER_BASE_URL,
    })

  const writeIdentityHook: IdentityWriter = async ({ home, agentName, scut }) => {
    const idPath = agentPaths(home, agentName).identity
    const id = await loadIdentity(idPath)
    const updated: typeof id.frontmatter = {
      ...id.frontmatter,
      scut,
    }
    await writeIdentity(idPath, updated, id.body)
  }

  const pipeline = new ProvisioningPipeline({
    home: args.home,
    agentName: args.agentName,
    masterKey,
    registerClient,
    keyStore: { generate: generateAgentKeypairs, write: writeAgentKeys },
    writeIdentity: writeIdentityHook,
  })

  const final = await pipeline.run()
  if (final.state !== 'registered') {
    throw new Error(`pipeline ended in state ${final.state}; check provision-state.json`)
  }
  if (!final.token_id || !final.scut_uri || !final.mint_tx_hash || !final.update_tx_hash) {
    throw new Error('pipeline reported registered but final state is missing required fields')
  }
  return {
    uri: final.scut_uri,
    tokenId: final.token_id,
    mintTx: final.mint_tx_hash,
    updateTx: final.update_tx_hash,
  }
}
