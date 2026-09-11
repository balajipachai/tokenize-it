import type { Metadata } from "next";
import { Console } from "../components/Console";

export const metadata: Metadata = {
  title: "Issuer console — tokenize-it",
  description: "Run the ESOP lifecycle: onboard, grant, suspend, terminate, claw back, pay.",
};

/**
 * The issuer half of the app.
 *
 * The wrapper is load-bearing, not decorative: the issuer stylesheet redefines `.shell`,
 * `.row` and the overlay classes and styles bare `header`/`label`/`input`, all of which
 * would reach the employee page now that both halves share one document. Scoping the block
 * under `.issuer` is what keeps one page's styling from being the other's problem.
 */
export default function IssuerPage() {
  return (
    <div className="issuer">
      <Console />
    </div>
  );
}
