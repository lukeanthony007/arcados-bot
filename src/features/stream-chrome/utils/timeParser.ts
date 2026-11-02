/**
 * Parse time strings into seconds
 * Supports formats like:
 * - "5:30" (5 minutes 30 seconds)
 * - "1:30:00" (1 hour 30 minutes)
 * - "1h30m" (1 hour 30 minutes)
 * - "90s" (90 seconds)
 * - "90" (90 seconds, default)
 */

/**
 * Parse a time string to seconds
 * @param timeString Time string in various formats
 * @returns Number of seconds, or null if parsing fails
 */
export function parseTimeString(timeString: string): number | null {
	if (!timeString || typeof timeString !== "string") {
		return null;
	}

	const trimmed = timeString.trim().toLowerCase();

	// Try format: "1:30:00" or "5:30" (HH:MM:SS or MM:SS) - check this first
	const colonMatch = trimmed.match(/^(\d+):(\d+)(?::(\d+))?$/);
	if (colonMatch) {
		if (colonMatch[3] !== undefined && colonMatch[3] !== "") {
			// HH:MM:SS format
			const hours = parseInt(colonMatch[1] ?? "0", 10);
			const minutes = parseInt(colonMatch[2] ?? "0", 10);
			const seconds = parseInt(colonMatch[3] ?? "0", 10);
			return hours * 3600 + minutes * 60 + seconds;
		} else {
			// MM:SS format
			const minutes = parseInt(colonMatch[1] ?? "0", 10);
			const seconds = parseInt(colonMatch[2] ?? "0", 10);
			return minutes * 60 + seconds;
		}
	}

	// Try format: "1h30m15s" or "1h 30m 15s"
	const hmsMatch = trimmed.match(
		/(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/
	);
	if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
		const hours = parseInt(hmsMatch[1] || "0", 10);
		const minutes = parseInt(hmsMatch[2] || "0", 10);
		const seconds = parseInt(hmsMatch[3] || "0", 10);
		const total = hours * 3600 + minutes * 60 + seconds;
		// Only return if we actually matched something (not just empty match)
		if (total > 0) {
			return total;
		}
	}

	// Try format: "90s" or "90" (just seconds)
	const secondsMatch = trimmed.match(/^(\d+)s?$/);
	if (secondsMatch) {
		return parseInt(secondsMatch[1] ?? "0", 10);
	}

	return null;
}

/**
 * Parse a time string, returning a default if parsing fails
 * @param timeString Time string to parse
 * @param defaultValue Default value if parsing fails
 * @returns Parsed seconds or default value
 */
export function parseTimeStringWithDefault(
	timeString: string,
	defaultValue: number
): number {
	const parsed = parseTimeString(timeString);
	return parsed !== null ? parsed : defaultValue;
}

