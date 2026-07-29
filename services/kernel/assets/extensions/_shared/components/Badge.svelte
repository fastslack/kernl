<script lang="ts">
  export let text: string = '';
  export let variant: string = '';
</script>

<span class="badge badge-{variant || (text || '').toLowerCase().replace(/\s+/g, '-')}">{text || ''}</span>
