I mostly just used cursor through its IDE and consulted Chatgpt 5.1 on the side as I went through the process mostly for things I needed to do outside the IDE like requesting certifications or just as another perspective on the problem as I debugged.

. I tried to feed the codebase into Codex for a bit there but it didn’t seem to understand the codebase as well as cursor did so I kept using the Cursor IDE. 

I didn’t try any MCPs. When I had a problem I mostly just copy pasted the error message into cursor or chatgpt and gave what I guessed the problem was. 

Effective Prompts:

“actually we should have some sort of general rule for snapping: it should snap to the top bottom, left or right relative to where the other object is.” 

This one helped a lot as instead of telling a blind AI to “fix shit” I realized what the solution should be instead just rolling the dice.

“Lets fix the UI on the bar on the left to make it more intuitive. Rather than having drag be solely tied to mouse3 I want a drag drop feature on the left symbolized by a hand. Cursor should change to a hand when hovering over the board. It'll move an object when targeting an object or pan when targeting space.”

Honestly I was pretty impressed with how nicely cursor made the UI look afterwards. It was always a “do it later” thing for me that I was dreading fighting with the AI over. Outside of its choice of icons I had to babysit shockingly little.

“"Create a SWOT analysis template with four quadrants" is still not working well. How do we make this model smarter?”

Cursor showed a lot initiative with this one in making a new tool for generating grids of frames. It was honestly much easier than having gpt 4o try and guess how to place the frames for SWOT.

Code Analysis: >99% AI generated. I heard somewhere that this program wanted us to move towards 100% AI generation so I’m trying to practice it now. Outside of a few stylistic things I got cursor to do everything.

Strengths & Limitations: The AI worked well when the task was bite sized. However much of the debugging was done by me. Obviously the aesthetic stuff had to be judged by me as well. Even if I had MCP worked in the AI might not necessarily have a strong opinion on UI.

Key Learnings: AI can do way more than I had expected as long as I keep the tasks bit sized. Given my trouble with integrating Redis and PostgresSQL I think I need to have better planning next time so I avoid the landmines of making big changes to my current code to accommodate for future features.





Usage costs:


Cursor
Input (w/o Cache Write)
Cache Read
Output Tokens
Total Tokens
Cost
Call


4317062
112832512
822055
117971629
38.558
157




Chatgpt
Total tokens
Total Requests
Total Spend


666,622
282
1.53


Render Projected total for February: $5.26


Production Cost Projections

Non-AI costs are mostly negligible in the face of AI usage.

A lot of the usages we explored in this project (SWOT, flowchart, etc) are short 1 hr top activities. In them AI was mostly used for scaffolding. For small custom changes (ex move things a little or change the color of a single element) the friction in waiting for AI and the tedium in describing what exactly a user wants would cause the user to act manually.

Let’s assume that the whiteboard becomes a workplace productivity tool that users use daily for an average of 20 days a month. Assume they have an average of two meetings a day on the tool. When users do use the tool, it’s generally in the setting of a single leader scaffolding with some of the other users using the AI once or twice for broad sweeping changes, to an average of about 3 per meeting. The is assuming the meetings are things like sprint retros. If they’re actually using the app to do PI planning that could balloon the usage.

That would generously estimate 120 commands per user per month. 

I had some difficulties breaking down the tokens per command types as I had trouble separating the system prompt level things from the variable token usages. So for estimation I’ll assume that my cost per command (~$.005) is a good estimate.


Monthly Users
Monthly Cost in Dollars
100
60
1000
600
10000
6000
100000
60000




