/**
 * Primitive component barrel.
 *
 * Engineers consuming primitives import from this file rather than the
 * individual files; this gives the component library a single import
 * surface and lets the directory layout evolve without callsite churn.
 *
 * Implementations of each primitive must conform to the contract in
 * wiki/design-system/component-contract.md. New primitives land in
 * the contract first, then here.
 */
export { agentColorClass } from './agentColorClass'
export { cx } from './cx'

export { AgentMark } from './AgentMark'
export type { AgentMarkProps, AgentMarkSize, AgentMarkState } from './AgentMark'

export { UserMark } from './UserMark'
export type { UserMarkProps, UserMarkSize, UserMarkState } from './UserMark'

export { Pill } from './Pill'
export type { PillProps, PillVariant } from './Pill'

export { PulseDot } from './PulseDot'
export type { PulseDotProps, PulseStateName } from './PulseDot'

export { Button } from './Button'
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button'

export { Input } from './Input'
export type { InputProps } from './Input'

export { Card } from './Card'
export type { CardProps } from './Card'

export { KV } from './KV'
export type { KVProps } from './KV'

export { SectionHeader } from './SectionHeader'
export type { SectionHeaderProps } from './SectionHeader'

export { PageHeader } from './PageHeader'
export type { PageHeaderProps } from './PageHeader'

export { Sparkline } from './Sparkline'
export type { SparklineProps } from './Sparkline'

export { ProgressBar } from './ProgressBar'
export type { ProgressBarProps, ProgressBarVariant } from './ProgressBar'

export { EmptyState, LoadingState, ErrorState } from './States'
export type { EmptyStateProps, LoadingStateProps, ErrorStateProps } from './States'

export { Tag } from './Tag'
export type { TagProps } from './Tag'

export { Code } from './Code'
export type { CodeProps } from './Code'

export { Kbd } from './Kbd'
export type { KbdProps } from './Kbd'

export { Meta } from './Meta'
export type { MetaProps } from './Meta'

export { Dot } from './Dot'
export type { DotProps, DotTone } from './Dot'

export { Field } from './Field'
export type { FieldProps } from './Field'

export { Breadcrumb } from './Breadcrumb'
export type { BreadcrumbProps } from './Breadcrumb'

export { Screen, ScreenNavLink } from './Screen'
export type { ScreenProps, ScreenNavLinkProps } from './Screen'

export { Tabs } from './Tabs'
export type { TabsProps, TabsItem } from './Tabs'

export { Segmented } from './Segmented'
export type { SegmentedProps, SegmentedOption } from './Segmented'
