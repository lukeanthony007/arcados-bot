import type { SearchResult } from "../../types.js";
import type { SelectionResult, SelectionStrategy } from "../../types/selection.js";

/**
 * Strategy for numeric selection (e.g., "2", "option 3", "the second one")
 */
export class NumericStrategy implements SelectionStrategy {
	/**
	 * Match numeric selection to search results
	 * Handles formats like:
	 * - "1", "2", "3" (direct numbers)
	 * - "option 2", "option 3" (with "option" prefix)
	 * - "the second one", "the third one" (ordinal text)
	 */
	match(query: string, results: SearchResult[]): SelectionResult | null {
		if (!query || results.length === 0) {
			return null;
		}

		const trimmed = query.trim().toLowerCase();

		// Try to extract number from query
		let index: number | null = null;

		// Direct number match: "1", "2", "3"
		const directMatch = trimmed.match(/^(\d+)$/);
		if (directMatch) {
			index = parseInt(directMatch[1] ?? "0", 10);
		}

		// "option X" or "option X" format
		if (index === null) {
			const optionMatch = trimmed.match(/option\s+(\d+)/i);
			if (optionMatch) {
				index = parseInt(optionMatch[1] ?? "0", 10);
			}
		}

		// Ordinal text: "first", "second", "third", etc.
		if (index === null) {
			const ordinalMap: Record<string, number> = {
				first: 1,
				second: 2,
				third: 3,
				fourth: 4,
				fifth: 5,
				sixth: 6,
				seventh: 7,
				eighth: 8,
				ninth: 9,
				tenth: 10,
			};

			for (const [word, num] of Object.entries(ordinalMap)) {
				if (trimmed.includes(word)) {
					index = num;
					break;
				}
			}
		}

		// "the X one" format: "the second one", "the third one"
		if (index === null) {
			const theMatch = trimmed.match(/the\s+(\d+)(?:st|nd|rd|th)?\s+one/i);
			if (theMatch) {
				index = parseInt(theMatch[1] ?? "0", 10);
			}
		}

		// If we found a number, validate it's within range
		if (index !== null) {
			// Convert to 0-based index
			const arrayIndex = index - 1;
			const selected = results[arrayIndex];
			if (arrayIndex >= 0 && selected) {
				return {
					selected,
					confidence: 1.0, // Exact match
					method: "numeric",
					index: arrayIndex,
				};
			}
		}

		return null;
	}
}

