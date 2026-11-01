import { RailSelect } from '../../components/index.ts';
import type { DomainDto } from '../../../shared/types/expert.ts';

/** "DOMAIN FILTER / Biology / Microbiology" from the frame's rail, as a select that really filters. */
export function DomainFilter({ value, options, onChange, disabled }: { value: string; options: DomainDto[]; onChange: (domainId: string) => void; disabled?: boolean }) {
  return <RailSelect label="Domain filter" value={value} onChange={onChange} disabled={disabled} options={options.map((domain) => ({ value: domain.id, label: `${domain.name} / ${domain.field}` }))} />;
}
