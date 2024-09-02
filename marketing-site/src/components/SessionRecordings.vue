<template>
    <div class="grid md:grid-cols-2 gap-10 mx-auto mt-16">

      <div class="text-center">
          <h1 class="text-2xl lg:text-2xl font-bold lg:tracking-tight mb-10">
            Recordings
          </h1>
          <table class="text-lg leading-relaxed text-slate-500 mt-3">
            <tr v-for="recording in recordings" :key="recording.id">
              <td>
                {{ recording?.page_title }}
              </td>
              <td>
                {{  new Date(recording.latest_timestamp) }}
              </td>
              <td>
                <a href="#" @click.prevent="loadRecording(recording.id)">{{ recording.id }}</a>
              </td>
            </tr>
          </table>
      </div>

      <div class="mt-6">
        <div id="replay"></div>
      </div>
    </div>

</template>

<script>
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';

import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'

TimeAgo.locale(en)

export default {
  name: 'SessionRecordings',
  data() {
    return {
      recordings: [],
      player: null,
      timeAgo: new TimeAgo('en-US'),
    };
  },
  async mounted() {
    try {
      const response = await fetch("ADD_YOUR_SANDBOX_URL/recordings", {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Network response was not ok');
      }

      const recordings = await response.json();
      this.recordings = recordings;
    } catch (error) {
      console.error('Failed to fetch recordings:', error);
    }
  },
  methods: {
    async loadRecording(id) {
      if (this.player) {
        this.player.pause();
        this.player = null;
        document.getElementById('replay').innerHTML = '';
      }
      const response = await fetch(`ADD_YOUR_SANDBOX_URL/recordings/${id}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      const results = await response.json()
      const events = []
      results.forEach((row) => {
        events.push(JSON.parse(row['recording']))
      })

      this.player = new rrwebPlayer({
        target: document.getElementById('replay'), // customizable root element
        props: {
          events,
        },
      });
      console.log(this.player)
    }
  }
};
</script>
