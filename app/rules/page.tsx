import Link from 'next/link';
import { Collapsible } from '@/components/Collapsible';
import { RULE_SECTIONS, SCORING_TABLE, type RuleList } from '@/lib/rulesContent';

function isRuleList(item: string | RuleList): item is RuleList {
  return typeof item !== 'string';
}

export default function RulesPage() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen max-w-md flex-col gap-3 px-3 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-qx-text">Rules and strategy</h1>
        <Link href="/" className="text-sm font-medium text-qx-text underline">
          Home
        </Link>
      </div>

      {RULE_SECTIONS.map((section, i) => (
        <Collapsible key={section.id} id={section.id} title={section.title} defaultOpen={i === 0}>
          <div className="flex flex-col gap-3 text-sm text-qx-text">
            {section.body.map((item, idx) =>
              isRuleList(item) ? (
                <ul key={idx} className="list-disc space-y-1.5 pl-5">
                  {item.items.map((line, lineIdx) => (
                    <li key={lineIdx}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p key={idx}>{item}</p>
              ),
            )}

            {section.id === 'cheat-sheet' && (
              <table className="w-full border-collapse text-sm">
                <caption className="mb-2 text-left text-xs text-qx-muted">Crosses to points</caption>
                <thead>
                  <tr className="border-b border-qx-line text-left">
                    <th scope="col" className="py-1">
                      Crosses
                    </th>
                    <th scope="col" className="py-1">
                      Points
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {SCORING_TABLE.map((row) => (
                    <tr key={row.crosses} className="border-b border-qx-line">
                      <td className="py-1">{row.crosses}</td>
                      <td className="py-1">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Collapsible>
      ))}
    </main>
  );
}
