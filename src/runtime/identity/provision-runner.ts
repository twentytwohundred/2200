/**
 * Production glue between the ProvisioningPipeline and the SCUT
 * config (Epic 4 Phase A PR F). Loads `<home>/config/scut.json`,
 * resolves the wallet private-key SecretRef, constructs an on-chain
 * client, loads the master key, and runs the pipeline against the
 * named Agent.
 *
 * Tests use ProvisioningPipeline directly with injected fakes; this
 * module is the production wiring.
 */
import { agentPaths } from '../storage/layout.js'
import { loadIdentity, writeIdentity } from './loader.js'
import { generateAgentKeypairs, loadOrCreateMasterKey, writeAgentKeys } from './keystore.js'
import { createScutOnChain } from './onchain.js'
import { ProvisioningPipeline, type IdentityWriter } from './provisioning.js'
import { loadScutConfig, resolveSecret } from './scut-config.js'

export interface ProvisionRunArgs {
  home: string
  agentName: string
}

export interface ProvisionRunResult {
  uri: string
  tokenId: string
  mintTx: string
  updateTx: string
}

/**
 * Resolve config + secrets, build the on-chain client + identity
 * writer, run the pipeline, return the user-visible result.
 *
 * Throws if the SCUT config is missing or the wallet address in
 * config does not match the address derived from the private key
 * (a sanity check that catches misconfiguration before spending gas).
 */
export async function runIdentityProvisionFromConfig(
  args: ProvisionRunArgs,
): Promise<ProvisionRunResult> {
  const config = await loadScutConfig(args.home)
  const privateKey = await resolveSecret(config.wallet_private_key)
  const onChainArgs: Parameters<typeof createScutOnChain>[0] = {
    rpcUrl: config.rpc_url,
    privateKey,
    contractAddress: config.contract_address,
  }
  if (config.ownerof_poll_interval_ms !== undefined) {
    onChainArgs.ownerOfPollIntervalMs = config.ownerof_poll_interval_ms
  }
  if (config.ownerof_poll_max_attempts !== undefined) {
    onChainArgs.ownerOfPollMaxAttempts = config.ownerof_poll_max_attempts
  }
  const onChain = createScutOnChain(onChainArgs)

  if (onChain.walletAddress.toLowerCase() !== config.wallet_address.toLowerCase()) {
    throw new Error(
      `wallet_address in scut.json (${config.wallet_address}) does not match the address derived from the configured private key (${onChain.walletAddress}). Refusing to provision; correct the config or the secret before retrying.`,
    )
  }

  const masterKey = await loadOrCreateMasterKey(args.home)

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
    chainId: config.chain_id,
    contractAddress: config.contract_address,
    masterKey,
    onChain,
    keyStore: { generate: generateAgentKeypairs, write: writeAgentKeys },
    writeIdentity: writeIdentityHook,
  })

  const final = await pipeline.run()
  if (final.state !== 'registered') {
    throw new Error(`pipeline ended in state ${final.state}; check provision-state.json`)
  }
  if (!final.token_id || !final.mint_tx_hash || !final.update_tx_hash) {
    throw new Error('pipeline reported registered but final state is missing required fields')
  }
  const composed = `scut://${String(config.chain_id)}/${config.contract_address.toLowerCase()}/${final.token_id}`
  return {
    uri: composed,
    tokenId: final.token_id,
    mintTx: final.mint_tx_hash,
    updateTx: final.update_tx_hash,
  }
}
