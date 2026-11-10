import chalk from 'chalk';
import { localizeUiText } from './i18n';

export const VERSION = '1.0.2';

// ANSI Shadow style banner: "AXION CLI"
const BANNER = [
   `█████╗ ██╗  ██╗██╗ ██████╗ ███╗   ██╗    ██████╗██╗     ██╗`,
   `██╔══██╗╚██╗██╔╝██║██╔═══██╗████╗  ██║   ██╔════╝██║     ██║`,
   `███████║ ╚███╔╝ ██║██║   ██║██╔██╗ ██║   ██║     ██║     ██║`,
   `██╔══██║ ██╔██╗ ██║██║   ██║██║╚██╗██║   ██║     ██║     ██║`,
   `██║  ██║██╔╝ ██╗██║╚██████╔╝██║ ╚████║   ╚██████╗███████╗██║`,
   `╚═╝  ╚═╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝    ╚═════╝╚══════╝╚═╝`,
];
export function printBanner(): void {
  console.log(chalk.cyan(BANNER.join('\n')));
  console.log(chalk.dim('   AI Agents CLI By AXION Neuralis'));
  console.log(chalk.dim(localizeUiText(`   v${VERSION} — type /help for commands, /exit to quit\n`)));
}