import type { OpenCompanyClient } from "@/api/client";
import { AdminOnlyNotice } from "@/components/admin-only-notice";
import { PageHeader } from "@/components/page-header";
import { PageTabs, pageTabIds, type PageTab } from "@/components/page-tabs";
import { useHashTab } from "@/hooks/use-hash-tab";
import { useCanManage } from "@/hooks/use-can-manage";
import { InferenceSection } from "@/views/connections/InferenceSection";

interface Props {
  client: OpenCompanyClient;
  company: string | null;
}

/**
 * Settings, Inference: which model this company's teammates think with, and
 * whose key pays for it.
 *
 * Its own page since the Connections split. It was a section on a page about
 * third-party accounts, which is the wrong neighbourhood twice over: an
 * inference provider is not an account the company *acts as*, and the question
 * it settles — what every teammate's turn costs and how good it is — is the one
 * an operator comes back to most. The body is
 * [`InferenceSection`](./connections/InferenceSection.tsx), unchanged: the same
 * component, given a page of its own rather than a copy.
 */
/**
 * The two questions the one inference form answers: how the company reaches a
 * model at all, and which model each cognition tier resolves to.
 *
 * They were one column, with the tier grid wedged between the base URL and the
 * key — so setting a key meant scrolling past six model selects, and choosing
 * models meant scrolling past a credential you set once a quarter.
 *
 * They are **views of one form**, not two forms. One draft, one Save; the
 * section stays mounted across a tab change and draws less of itself. See
 * `InferenceSection`'s `view` prop for why that matters.
 */
const INFERENCE_TABS = [
  { id: "connect", label: "Connect" },
  { id: "routing", label: "Manage Routing" },
] as const satisfies readonly PageTab<string>[];

type InferenceTab = (typeof INFERENCE_TABS)[number]["id"];

export function InferenceView({ client, company }: Props) {
  const [tab, setTab] = useHashTab<InferenceTab>(
    INFERENCE_TABS.map((t) => t.id),
    "connect",
  );
  // Changing the model or the key changes what every teammate's turn costs, so
  // it is an admin's.
  const canManage = useCanManage(client, company);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="LLM"
        width="full"
        description={
          <>
            The model your agents think with, and the key their turns are billed to.
          </>
        }
        tabs={
          <PageTabs
            tabs={INFERENCE_TABS}
            value={tab}
            onChange={setTab}
            idBase="inference"
            aria-label="Inference views"
          />
        }
      />
      <div className="min-h-0 w-full flex-1 space-y-6 overflow-y-auto px-4 py-6">
        {!canManage && (
          <AdminOnlyNotice
            testId="inference-read-only"
            title="Only an admin can change this company's model"
          >
            The model and its key decide what every agent&apos;s turn costs, so an admin sets
            them. You can see what is configured.
          </AdminOnlyNotice>
        )}

        {/*
          One mounted section, not one per tab. The panel identity moves with
          the active tab while the component underneath is the same instance —
          which is what keeps a draft typed on Connect alive while you pick
          models on Manage Routing, since one Save writes both.
        */}
        <div
          role="tabpanel"
          id={pageTabIds("inference", tab).panel}
          aria-labelledby={pageTabIds("inference", tab).tab}
        >
          <InferenceSection
            client={client}
            company={company}
            canManage={canManage}
            view={tab}
          />
        </div>
      </div>
    </div>
  );
}
