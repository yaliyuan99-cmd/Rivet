import { Actions, LinkButton, Page, PageHeader, Section } from '../../components/index.ts';

export default function NotFoundPage() {
  return (
    <Page title="Page not found">
      <PageHeader eyebrow="Rivet" title="This page does not exist." subtitle="The link may be out of date, or the item may have moved." status="404" statusTone="warning" />
      <Section title="Where to go next">
        <p>Tasks, datasets and reports you have access to are all reachable from the navigation.</p>
      </Section>
      <Actions>
        <LinkButton variant="primary" to="/">
          Return to Home
        </LinkButton>
      </Actions>
    </Page>
  );
}
