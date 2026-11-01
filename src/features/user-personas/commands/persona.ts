import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../../../types";
import type { UserPersonaService } from "../UserPersonaService";

interface BotClient {
	userPersonas?: UserPersonaService;
}

export const personaCommand: Command = {
	data: new SlashCommandBuilder()
		.setName("persona")
		.setDescription("Have Ariya speak as a server member")
		.addSubcommand((sub) =>
			sub
				.setName("init")
				.setDescription(
					"Build a member's persona from their messages, conversations and relationships",
				)
				.addUserOption((opt) =>
					opt
						.setName("user")
						.setDescription("Member to build")
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("change")
				.setDescription("Make Ariya speak as a member's persona")
				.addUserOption((opt) =>
					opt
						.setName("user")
						.setDescription("Member to speak as")
						.setRequired(true),
				),
		)
		.addSubcommand((sub) =>
			sub
				.setName("clear")
				.setDescription("Switch Ariya back to her normal self"),
		),

	async execute(interaction: ChatInputCommandInteraction) {
		const guildId = interaction.guildId;
		if (!guildId) {
			await interaction.reply({
				content: "Personas only work in servers.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const service = (interaction.client as BotClient).userPersonas;
		if (!service?.isAvailable()) {
			await interaction.reply({
				content: "Personas need the database, which isn't connected right now.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const subcommand = interaction.options.getSubcommand();
		if (subcommand === "init") {
			await initPersona(interaction, service, guildId);
		} else if (subcommand === "change") {
			await changePersona(interaction, service, guildId);
		} else {
			await clearPersona(interaction, service, guildId);
		}
	},
};

async function initPersona(
	interaction: ChatInputCommandInteraction,
	service: UserPersonaService,
	guildId: string,
): Promise<void> {
	const target = interaction.options.getUser("user", true);
	const member = interaction.options.getMember("user");
	const label =
		member && "displayName" in member ? member.displayName : target.displayName;

	await interaction.deferReply();
	const result = await service.buildPersona(
		guildId,
		target.id,
		interaction.user.id,
		async (step) => {
			await interaction.editReply(`Building **${label}**'s persona… ${step}`);
		},
	);

	if (!result.success) {
		await interaction.editReply(
			`Couldn't build **${label}**'s persona: ${result.error}`,
		);
		return;
	}

	const { persona, report } = result;
	const profile = persona.character_profile;
	const embed = new EmbedBuilder()
		.setTitle(`${persona.display_name}'s persona`)
		.setDescription(
			profile.length > 4000 ? `${profile.slice(0, 3997)}…` : profile,
		)
		.setFooter({
			text: `Built from ${report.messagesAnalyzed} messages, ${report.conversationsAnalyzed} conversations, ${report.relationships} relationships`,
		});

	await interaction.editReply({
		content: `**${persona.display_name}**'s persona is ready. Use \`/persona change\` to have Ariya speak as them.`,
		embeds: [embed],
	});
}

async function changePersona(
	interaction: ChatInputCommandInteraction,
	service: UserPersonaService,
	guildId: string,
): Promise<void> {
	const target = interaction.options.getUser("user", true);
	const existing = await service.getPersona(guildId, target.id);
	if (!existing.success) {
		await interaction.reply({
			content: `Couldn't load that persona: ${existing.error}`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	if (!existing.data) {
		await interaction.reply({
			content: `No persona for **${target.displayName}** yet. Run \`/persona init\` on them first.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const activated = await service.activatePersona(
		guildId,
		target.id,
		interaction.user.id,
	);
	if (!activated.success) {
		await interaction.reply({
			content: `Couldn't switch persona: ${activated.error}`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply(
		`Ariya is now speaking as **${existing.data.display_name}**. Mention her to talk to them, or use \`/persona clear\` to switch back.`,
	);
}

async function clearPersona(
	interaction: ChatInputCommandInteraction,
	service: UserPersonaService,
	guildId: string,
): Promise<void> {
	const cleared = await service.clearActivePersona(guildId);
	if (!cleared.success) {
		await interaction.reply({
			content: `Couldn't clear the persona: ${cleared.error}`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply(
		cleared.data
			? "Ariya is back to her normal self."
			: "Ariya wasn't using a persona.",
	);
}
