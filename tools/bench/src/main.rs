use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

mod mock;
mod runner;
mod stats;

#[cfg(test)]
mod tests;

#[derive(Parser, Debug)]
#[command(name = "bench", about = "Mahoquot benchmark and mock upstream harness")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Run deterministic mock SSE upstream server
    Mock(MockArgs),
    /// Run concurrent TTFT sampling benchmark
    Run(RunArgs),
}

#[derive(Args, Debug)]
pub struct MockArgs {
    #[arg(short, long)]
    pub port: u16,

    #[arg(long, default_value_t = 40)]
    pub ttft_ms: u64,

    #[arg(long, default_value_t = 20)]
    pub chunks: usize,

    #[arg(long, default_value_t = 0)]
    pub fail_first_n: usize,

    #[arg(long, default_value_t = 429)]
    pub fail_status: u16,

    #[arg(long, default_value = "openai")]
    pub protocol: mock::MockProtocol,
}

#[derive(Args, Debug)]
pub struct RunArgs {
    #[arg(short, long)]
    pub url: String,

    #[arg(short, long)]
    pub concurrency: usize,

    #[arg(short = 't', long = "total")]
    pub total: usize,

    #[arg(short, long)]
    pub out: PathBuf,

    #[arg(short = 'H', long = "header", action = clap::ArgAction::Append)]
    pub header: Vec<String>,

    #[arg(long)]
    pub body_json: Option<String>,

    #[arg(long, default_value_t = 10000)]
    pub timeout_ms: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Mock(args) => {
            let cfg = mock::MockConfig {
                port: args.port,
                ttft_ms: args.ttft_ms,
                chunks: args.chunks,
                fail_first_n: args.fail_first_n,
                fail_status: args.fail_status,
                protocol: args.protocol,
            };
            mock::run_mock_server(cfg).await?;
        }
        Commands::Run(args) => {
            let cfg = runner::BenchConfig {
                url: args.url,
                concurrency: args.concurrency,
                total: args.total,
                out: args.out,
                headers: args.header,
                body_json: args.body_json,
                timeout_ms: args.timeout_ms,
            };
            runner::run_benchmark(cfg).await?;
        }
    }
    Ok(())
}
