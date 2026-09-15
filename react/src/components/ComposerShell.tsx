import { IconPlus } from '@tabler/icons-react';
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { ProfileInputsInterface } from 'theorum/interface';
import type { ComposerAttachmentItem } from './ComposerAttachmentsRow';
import { ComposerAttachmentsRow } from './ComposerAttachmentsRow';

export function ComposerIssues(props: {
	issues: readonly string[];
	attachNotice: string;
	voiceError: string;
}) {
	if (!props.issues.length && !props.voiceError && !props.attachNotice) return null;
	return (
		<ul className="iface-composer__issues" aria-live="polite">
			{props.issues.map((issue) => (
				<li key={issue}>{issue}</li>
			))}
			{props.attachNotice ? <li key="attach-notice">{props.attachNotice}</li> : null}
			{props.voiceError ? <li key="voice-error">{props.voiceError}</li> : null}
		</ul>
	);
}

function voiceHint(recording: boolean, voiceCount: number): string {
	if (recording) return 'Listening…';
	if (voiceCount > 0) return 'Voice ready — send';
	return 'tap mic to record';
}

function ComposerAttachControl(props: {
	inputs: ProfileInputsInterface;
	recording: boolean;
	inputLocked: boolean;
	onFiles: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
	if (!props.inputs.attachments) return null;
	return (
		<label className="iface-composer__attach">
			<IconPlus size={18} stroke={1.75} aria-hidden="true" />
			<span className="sr-only">Attach file</span>
			<input
				accept={props.inputs.attachments.acceptAttr}
				className="iface-composer__file"
				disabled={props.recording || props.inputLocked}
				multiple={props.inputs.maxFiles !== 1}
				onChange={props.onFiles}
				type="file"
			/>
		</label>
	);
}

function ComposerTextOrVoice(props: {
	inputs: ProfileInputsInterface;
	text: string;
	recording: boolean;
	inputLocked: boolean;
	expanded: boolean;
	voiceEnabled: boolean;
	voiceCount: number;
	placeholder: string;
	inputClass: string;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	onTextChange?: (value: string) => void;
}) {
	if (props.inputs.text) {
		const hidePlaceholder = props.expanded && !props.recording && props.voiceCount === 0;
		return (
			<textarea
				ref={props.textareaRef}
				className={props.inputClass}
				disabled={props.recording || props.inputLocked}
				onKeyDown={props.onKeyDown}
				onInput={(event) => props.onTextChange?.(event.currentTarget.value)}
				placeholder={hidePlaceholder ? '' : props.placeholder}
				rows={1}
				value={props.text}
			/>
		);
	}
	if (!props.voiceEnabled) return null;
	return (
		<p className="iface-composer__voice-hint">{voiceHint(props.recording, props.voiceCount)}</p>
	);
}

export function ComposerInputArea(props: {
	inputs: ProfileInputsInterface;
	text: string;
	recording: boolean;
	inputLocked: boolean;
	expanded: boolean;
	voiceEnabled: boolean;
	voiceCount: number;
	placeholder: string;
	innerClass: string;
	inputClass: string;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	innerRef: RefObject<HTMLDivElement | null>;
	onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	onTextChange?: (value: string) => void;
	onFiles: (event: ChangeEvent<HTMLInputElement>) => void;
	children: ReactNode;
}) {
	return (
		<div className={props.innerClass} ref={props.innerRef}>
			<ComposerAttachControl
				inputs={props.inputs}
				recording={props.recording}
				inputLocked={props.inputLocked}
				onFiles={props.onFiles}
			/>
			<ComposerTextOrVoice
				inputs={props.inputs}
				text={props.text}
				recording={props.recording}
				inputLocked={props.inputLocked}
				expanded={props.expanded}
				voiceEnabled={props.voiceEnabled}
				voiceCount={props.voiceCount}
				placeholder={props.placeholder}
				inputClass={props.inputClass}
				textareaRef={props.textareaRef}
				onKeyDown={props.onKeyDown}
				onTextChange={props.onTextChange}
			/>
			{props.children}
		</div>
	);
}

function shellClassName(focused: boolean): string {
	return focused
		? 'iface-composer__shell iface-composer__shell--focus'
		: 'iface-composer__shell';
}

export function ComposerShell(props: {
	shellRef: RefObject<HTMLDivElement | null>;
	attachRowRef: RefObject<HTMLDivElement | null>;
	shellFocused: boolean;
	recording: boolean;
	inputLevel: number;
	attachItems: readonly ComposerAttachmentItem[];
	onAttachRemove: (id: string) => void;
	onFocus: () => void;
	onBlur: (related: EventTarget | null, current: HTMLDivElement) => void;
	children: ReactNode;
}) {
	return (
		<div
			ref={props.shellRef}
			className={shellClassName(props.shellFocused)}
			onFocusCapture={props.onFocus}
			onBlurCapture={(event) => {
				props.onBlur(event.relatedTarget, event.currentTarget);
			}}
		>
			<div ref={props.attachRowRef}>
				<ComposerAttachmentsRow
					inputLevel={props.recording ? props.inputLevel : 0}
					items={props.attachItems}
					onRemove={props.onAttachRemove}
					recording={props.recording}
				/>
			</div>
			{props.children}
		</div>
	);
}
