import type { ReactElement } from 'react'
import {
  AgentMark,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  KV,
  LoadingState,
  Pill,
  ProgressBar,
  Screen,
  SectionHeader,
  Sparkline,
  UserMark,
} from '../primitives'
import { useTheme } from '../theme/ThemeProvider'
import styles from './ComponentsPage.module.css'

const FAKE_AGENTS = [
  { id: 'hobby', name: 'Hobby' },
  { id: 'simon', name: 'Simon' },
  { id: 'poe', name: 'Poe' },
  { id: 'guppi', name: 'Guppi' },
  { id: 'david', name: 'David' },
  { id: 'mira', name: 'Mira' },
  { id: 'juno', name: 'Juno' },
  { id: 'rocky', name: 'Rocky' },
] as const

const SPARKLINE_DATA = [4, 6, 5, 8, 7, 9, 6, 11, 8, 12, 10, 14]

export function ComponentsPage(): ReactElement {
  const { theme, toggle } = useTheme()

  return (
    <Screen
      crumbs={['2200', 'dev', 'components']}
      title="Component library"
      lede="Every primitive in every state. Engineering reference for Epic 15 implementation."
      actions={
        <Button variant="ghost" size="sm" onClick={toggle} kbd="T">
          switch theme
        </Button>
      }
    >
      <Section title="Pill · status">
        <div className={styles.row}>
          <Pill variant="running">RUNNING</Pill>
          <Pill variant="attention">NEEDS YOU</Pill>
          <Pill variant="error">ERROR</Pill>
          <Pill variant="info">INFO</Pill>
          <Pill variant="idle">IDLE</Pill>
          <Pill variant="draft">DRAFT</Pill>
          <Pill variant="running" dot={false}>
            NO DOT
          </Pill>
        </div>
      </Section>

      <Section title="Button · variant + size">
        <div className={styles.row}>
          <Button variant="default">Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button disabled>Disabled</Button>
          <Button kbd="⌘ K">With kbd</Button>
        </div>
        <div className={styles.row}>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
          <Button icon size="sm">
            +
          </Button>
          <Button icon>+</Button>
          <Button icon size="lg">
            +
          </Button>
        </div>
      </Section>

      <Section title="Input">
        <div className={styles.row} style={{ maxWidth: 480 }}>
          <Input placeholder="Search agents, brain notes, tasks..." />
        </div>
        <div className={styles.row} style={{ maxWidth: 480 }}>
          <Input leadingSlot="⌘K" placeholder="With leading slot" />
        </div>
        <div className={styles.row} style={{ maxWidth: 480 }}>
          <Input value="hobby" readOnly />
        </div>
        <div className={styles.row} style={{ maxWidth: 480 }}>
          <Input placeholder="Disabled" disabled />
        </div>
      </Section>

      <Section title="AgentMark · deterministic 12-color palette">
        <div className={styles.row}>
          {FAKE_AGENTS.map((a) => (
            <AgentMark key={a.id} id={a.id} name={a.name} size="md" />
          ))}
        </div>
        <div className={styles.row}>
          <AgentMark id="hobby" name="Hobby" size="sm" />
          <AgentMark id="hobby" name="Hobby" size="md" />
          <AgentMark id="hobby" name="Hobby" size="lg" />
          <AgentMark id="hobby" name="Hobby" size="xl" />
        </div>
        <div className={styles.row}>
          <AgentMark id="simon" name="Simon" size="lg" />
          <AgentMark id="simon" name="Simon" size="lg" solid />
          <AgentMark id="simon" name="Simon" size="lg" state="speaking" />
          <AgentMark id="simon" name="Simon" size="lg" state="thinking" />
        </div>
      </Section>

      <Section title="UserMark · single distinct gradient">
        <div className={styles.row}>
          <UserMark size="sm" />
          <UserMark size="md" />
          <UserMark size="lg" />
          <UserMark size="xl" />
          <UserMark size="lg" state="speaking" />
          <UserMark size="lg" state="thinking" />
        </div>
      </Section>

      <Section title="Card · padding / flat / elevated">
        <div className={styles.tileGrid}>
          <Card padding={16}>
            <KV k="THEME" v={<span className={styles.mono}>{theme}</span>} />
            <KV k="STATE" v={<Pill variant="running">RUNNING</Pill>} />
            <KV k="COST" v={<span className={styles.mono}>$0.0234</span>} />
          </Card>
          <Card padding={16} flat>
            <KV k="VARIANT" v="flat" />
            <KV k="RADIUS" v={<span className={styles.mono}>md (6px)</span>} />
          </Card>
          <Card padding={16} elevated>
            <KV k="VARIANT" v="elevated" />
            <KV k="SHADOW" v={<span className={styles.mono}>elevation-1</span>} />
          </Card>
        </div>
      </Section>

      <Section title="Headers · Section + Page">
        <Card padding={20}>
          <SectionHeader title="RUNNING · 4" action={<Pill variant="running">LIVE</Pill>} />
          <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 13 }}>
            Body content sits below the section header. The divider above the body is part of the
            header itself.
          </p>
        </Card>
      </Section>

      <Section title="Sparkline · token-driven color">
        <div className={styles.row}>
          <Sparkline data={SPARKLINE_DATA} color="var(--accent)" />
          <Sparkline data={SPARKLINE_DATA} color="var(--warn)" w={120} h={24} />
          <Sparkline data={SPARKLINE_DATA} color="var(--danger)" w={160} h={32} />
          <Sparkline data={[1, 1]} />
        </div>
      </Section>

      <Section title="ProgressBar · auto flips at 75% / 90%">
        <div className={styles.barStack}>
          <KV k="40%" v={<ProgressBar value={40} ariaLabel="40 percent" />} kw={48} />
          <KV k="60%" v={<ProgressBar value={60} ariaLabel="60 percent" />} kw={48} />
          <KV k="78%" v={<ProgressBar value={78} ariaLabel="78 percent" />} kw={48} />
          <KV k="92%" v={<ProgressBar value={92} ariaLabel="92 percent" />} kw={48} />
          <KV
            k="HEIGHT"
            v={<ProgressBar value={50} height={8} ariaLabel="50 percent, taller bar" />}
            kw={48}
          />
        </div>
      </Section>

      <Section title="EmptyState · LoadingState · ErrorState">
        <div className={styles.stateGrid}>
          <Card padding={0}>
            <EmptyState
              icon={<span aria-hidden="true">○</span>}
              title="No notifications"
              body="When an Agent emits an ask, it shows up here."
              action={<Button size="sm">Send a task</Button>}
            />
          </Card>
          <Card padding={20}>
            <LoadingState rows={5} />
          </Card>
          <Card padding={0}>
            <ErrorState
              title="Something went wrong"
              body="The runtime did not respond in time. Check the supervisor log."
              action={<Button size="sm">Retry</Button>}
            />
          </Card>
        </div>
      </Section>
    </Screen>
  )
}

interface SectionProps {
  title: string
  children: ReactElement | ReactElement[]
}

function Section({ title, children }: SectionProps): ReactElement {
  return (
    <section className={styles.section}>
      <SectionHeader title={title} />
      <div className={styles.sectionBody}>{children}</div>
    </section>
  )
}
