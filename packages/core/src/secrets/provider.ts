/**
 * Secret provider abstraction. V1 ships `EnvSecretProvider` (default).
 * Phase 13 adds `AwsKmsSecretProvider` + `HashiCorpVaultSecretProvider`.
 *
 * `getSecret` returns either a single string or an array (rotation grace
 * period — webhook handlers try each until one verifies).
 */

import { SecretFetchError } from "../errors/index.js";

export interface SecretProvider {
  getSecret(name: string): Promise<string | readonly string[]>;
}

export class EnvSecretProvider implements SecretProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async getSecret(name: string): Promise<string> {
    const value = this.env[name];
    if (value === undefined || value === "") {
      throw new SecretFetchError(`Env var '${name}' is not set`);
    }
    return value;
  }
}
