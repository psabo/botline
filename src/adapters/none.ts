// Poll-only agent (e.g. Muse): nothing to ring. doorbell.ts logs `no_doorbell` before reaching here.
import type { Adapter } from "../doorbell";

export const allows = () => false;

export const ring: Adapter = async () => ({ status: "no_doorbell" });
