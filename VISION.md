I want to make an app that lets users search Wood Talk podcast transcriptions. They have a search, but it covers only what's in the show notes/tags. I imagine downloading all the episodes, running a transcription model on the audio (Whisper) and then time coding and indexing the results for the search.

The transcription itself can run on my new Mac Mini since it's a decicated AI/LLM server.

We will also need to build a simple, but slick frontend. Enter search phrase (with some modifiers maybe) and get the results. Each result shows the portion of the transcripts with search hits highlighted, and then links to the canonical episode location, cued up to 5-10 seconds before where the hit was. Maybe also let people look at the larger transcript excerpt via a button/mouseover.

Could also do a brief summary of topics in each episode and link to those (if can be clearly extracted).

Where to host it is another matter. My own infrastructure (requires careful security procedures), Amazon EC2 server, or elsewhere. Open to recommendations. Free is good, but willing to pay a bit of money.

If there is already something out there that indexes podcasts and provides this kind of features for free, let me know.
