import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

/**
 * Self-signed builds arrive on electron-builder's ad hoc path (identity "-") and
 * are signed with T3CODE_MAC_SELF_SIGN_IDENTITY instead; see the mac config in
 * build-desktop-artifact.ts.
 */
export default async function sign(options: SignOptions): Promise<void> {
  const selfSignIdentity = process.env.T3CODE_MAC_SELF_SIGN_IDENTITY?.trim();
  await signApplication({
    ...options,
    ...(options.identity === "-" && selfSignIdentity ? { identity: selfSignIdentity } : {}),
    batchCodesignCalls: true,
  });
}
