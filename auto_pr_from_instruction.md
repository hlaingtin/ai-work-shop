#!/usr/bin/env python3
import argparse
import os
import subprocess
import sys
from pathlib import Path
import textwrap
import json
import requests
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# ------------- Utility: run shell commands ------------- #

def run_cmd(cmd, cwd=None, check=True, capture_output=False):
    print(f"[cmd] {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        capture_output=capture_output,
    )
    if check and result.returncode != 0:
        print(f"[error] Command failed with exit code {result.returncode}")
        if capture_output:
            print(result.stdout)
            print(result.stderr)
        sys.exit(result.returncode)
    return result


# ------------- OpenAI / ChatGPT call ------------- #

def call_chatgpt_to_modify_repo(instruction: str, repo_path: Path) -> str:
    """
    Call OpenAI API with an instruction and ask it to output
    a JSON plan of file changes.
    This is a simple pattern: the model returns which files to create/update
    and their full contents.
    """

    # Get API key from environment variable (loaded from .env file)
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("[error] OPENAI_API_KEY is not set. Please set it in .env file or as an environment variable.")
        sys.exit(1)

    # Read a simple file tree snapshot to give context to the model
    # (only up to some depth / number of files)
    tree_output = run_cmd(
        ["find", ".", "-maxdepth", "4", "-type", "f", "-not", "-path", "./.git/*"],
        cwd=str(repo_path),
        capture_output=True,
    )
    repo_files = tree_output.stdout.splitlines()
    repo_files_text = "\n".join(repo_files[:100])  # limit to first 100 files

    system_prompt = """You are an assistant that edits a GitHub repository.
You will receive an instruction and a list of existing files.
You must respond ONLY with JSON in the following format:

{
  "changes": [
    {
      "path": "relative/path/from/repo/root.txt",
      "action": "create_or_update",
      "content": "FULL FILE CONTENT HERE"
    }
  ]
}

Rules:
- Do not include comments outside the JSON.
- For each file, always provide the FULL desired final content.
- Do not use backticks in the JSON.
"""

    user_prompt = f"""
Instruction from user:

\"\"\"{instruction}\"\"\"

Current repo files (first 100):

\"\"\"{repo_files_text}\"\"\""""

    # OpenAI API HTTP call (chat.completions)
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.2,
    }

    print("[info] Calling OpenAI API for repo modifications...")
    resp = requests.post(url, headers=headers, json=body)
    if resp.status_code != 200:
        print("[error] OpenAI API call failed")
        print("Status:", resp.status_code)
        print("Response:", resp.text)
        sys.exit(1)

    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return content


def apply_changes_from_json(plan_json: str, repo_path: Path):
    """
    Given model output JSON like:
    {
      "changes": [
        { "path": "foo.txt", "action": "create_or_update", "content": "..." }
      ]
    }
    create/update files accordingly.
    """
    try:
        plan = json.loads(plan_json)
    except json.JSONDecodeError as e:
        print("[error] Failed to parse model output as JSON")
        print(plan_json)
        print(e)
        sys.exit(1)

    changes = plan.get("changes", [])
    if not changes:
        print("[info] No changes in plan. Exiting.")
        sys.exit(0)

    for change in changes:
        path = change.get("path")
        action = change.get("action")
        content = change.get("content", "")

        if not path or action not in ("create_or_update",):
            print(f"[warn] Skipping invalid change entry: {change}")
            continue

        target = repo_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"[info] Writing file: {target}")
        target.write_text(content, encoding="utf-8")


# ------------- GitHub PR creation ------------- #

def create_pr(owner_repo, base_branch, feature_branch, title, body, token):
    url = f"https://api.github.com/repos/{owner_repo}/pulls"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }
    payload = {
        "title": title,
        "head": feature_branch,
        "base": base_branch,
        "body": body,
    }

    print(f"[info] Creating PR via GitHub API: {url}")
    resp = requests.post(url, json=payload, headers=headers)
    if resp.status_code != 201:
        print("[error] Failed to create PR")
        print("Status:", resp.status_code)
        print("Response:", resp.text)
        sys.exit(1)

    pr = resp.json()
    print(f"[success] PR created: {pr.get('html_url')}")


# ------------- Main flow ------------- #

def main():
    parser = argparse.ArgumentParser(
        description="Use ChatGPT instruction to modify repo, commit, push, and open a PR."
    )
    parser.add_argument(
        "--repo",
        help="GitHub repo in the form owner/repo (e.g. spice-factory/my-repo). If omitted, uses GITHUB_REPO_HARDCODED.",
    )
    parser.add_argument(
        "--base",
        help="Base branch name for PR (e.g. main, develop). If omitted, uses GITHUB_BASE_BRANCH_HARDCODED.",
    )
    parser.add_argument(
        "--branch-name",
        help="Feature branch name (default: auto/<slug-of-instruction>)",
    )
    parser.add_argument(
        "--instruction",
        help="Instruction in natural language, e.g. 'create a random checklist file for creating github repo'. "
             "If omitted, you will be prompted.",
    )
    parser.add_argument(
        "--pr-title",
        help="Optional custom PR title. Defaults to 'Auto: <instruction>' (shortened).",
    )
    parser.add_argument(
        "--pr-body-file",
        help="Optional path to a text file used as PR body. If omitted, a simple default is used.",
    )
    args = parser.parse_args()

    # Use CLI args or environment variables (loaded from .env file)
    owner_repo = args.repo or os.getenv("GITHUB_REPO")
    base_branch = args.base or os.getenv("GITHUB_BASE_BRANCH")
    
    if not owner_repo:
        print("[error] GitHub repo not set. Provide --repo or set GITHUB_REPO in .env file.")
        sys.exit(1)
    if not base_branch:
        print("[error] Base branch not set. Provide --base or set GITHUB_BASE_BRANCH in .env file.")
        sys.exit(1)
    
    repo_path = Path(".").resolve()

    # Get GitHub token from environment variable (loaded from .env file)
    github_token = os.getenv("GITHUB_TOKEN")
    if not github_token:
        print("[error] GITHUB_TOKEN is not set. Please set it in .env file or as an environment variable.")
        sys.exit(1)

    # To hardcode the instruction instead of using CLI args, replace the block below with:
    # instruction = "create a random check list file for creating github repo"
    instruction = args.instruction
    if not instruction:
        print("Enter instruction (end with Ctrl+D / Ctrl+Z):")
        instruction = sys.stdin.read().strip()
        if not instruction:
            print("[error] No instruction provided.")
            sys.exit(1)

    # Very simple slug from instruction for branch name
    def slugify(text, max_len=40):
        cleaned = "".join(
            c.lower() if c.isalnum() else "-" for c in text.strip()
        )
        while "--" in cleaned:
            cleaned = cleaned.replace("--", "-")
        cleaned = cleaned.strip("-")
        return cleaned[:max_len] or "change"

    branch_slug = slugify(instruction)
    feature_branch = args.branch_name or f"auto/{branch_slug}"

    # PR title & body
    short_instr = (instruction[:60] + "...") if len(instruction) > 60 else instruction
    pr_title = args.pr_title or f"Auto: {short_instr}"

    if args.pr_body_file:
        body_text = Path(args.pr_body_file).read_text(encoding="utf-8")
    else:
        body_text = textwrap.dedent(
            f"""
            This PR was created automatically from the following instruction:

            > {instruction}

            Base branch: {base_branch}

            Please review carefully before merging.
            """
        ).strip()

    # 1. Ensure git repo
    run_cmd(["git", "rev-parse", "--is-inside-work-tree"])

    # 2. Checkout base branch and pull latest
    run_cmd(["git", "fetch", "origin", base_branch])
    run_cmd(["git", "checkout", base_branch])
    run_cmd(["git", "pull", "origin", base_branch])

    # 3. Create feature branch
    run_cmd(["git", "checkout", "-b", feature_branch])

    # 4. Call ChatGPT to get JSON plan and apply changes
    plan_json = call_chatgpt_to_modify_repo(instruction, repo_path)
    apply_changes_from_json(plan_json, repo_path)

    # 5. Check if there are changes
    status_res = run_cmd(
        ["git", "status", "--porcelain"], capture_output=True, check=False
    )
    if not status_res.stdout.strip():
        print("[info] No changes detected after applying AI plan. Exiting.")
        sys.exit(0)

    # 6. Commit changes
    run_cmd(["git", "add", "."])
    commit_message = f"Auto: {short_instr}"
    run_cmd(["git", "commit", "-m", commit_message])

    # 7. Push branch
    run_cmd(["git", "push", "origin", feature_branch])

    # 8. Create PR
    create_pr(owner_repo, base_branch, feature_branch, pr_title, body_text, github_token)


if __name__ == "__main__":
    main()

