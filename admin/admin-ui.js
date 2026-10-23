'use strict';

// ---------------------------------------------------------
// MOCK DATA (Identified clearly to avoid confusion)
// ---------------------------------------------------------
const MOCK_TEACHERS = [
  { id: 'TCH-1024', name: 'Rajesh Kumar', inst: 'Govt. Inter College', status: 'Active' },
  { id: 'TCH-1089', name: 'Priya Sharma', inst: 'Govt. Girls High School', status: 'Active' },
  { id: 'TCH-1102', name: 'Amit Patel', inst: 'Govt. Inter College', status: 'Suspended' }
];

const MOCK_INSTITUTIONS = [
  { name: 'Govt. Inter College', type: 'Senior Secondary', count: 42, status: 'Configured' },
  { name: 'Govt. Girls High School', type: 'Secondary', count: 28, status: 'Configured' }
];

const MOCK_INSPECTION = [
  { time: '2026-10-22T07:42:00Z', id: 'TCH-1024', name: 'Rajesh Kumar', inst: 'Govt. Inter College', status: 'Present', gps: true, face: true },
  { time: '2026-10-22T08:14:00Z', id: 'TCH-1089', name: 'Priya Sharma', inst: 'Govt. Girls High School', status: 'Present', gps: true, face: true },
  { time: '2026-10-22T08:22:00Z', id: 'TCH-1102', name: 'Amit Patel', inst: 'Govt. Inter College', status: 'Late', gps: true, face: true },
  { time: '2026-10-22T09:05:00Z', id: 'TCH-9999', name: 'Unknown User', inst: 'Govt. Inter College', status: 'Absent', gps: false, face: false }
];

// ---------------------------------------------------------
// UI LOGIC & NAVIGATION
// ---------------------------------------------------------
const sidebar = document.getElementById('sidebar');
const mobileMenuBtn = document.getElementById('mobile-menu');
const mobileCloseBtn = document.getElementById('mobile-close');
const pageTitle = document.getElementById('page-title');
const navItems = document.querySelectorAll('.nav-item');
const viewSections = document.querySelectorAll('.view-section');

// Navigation toggle
navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    // Update active states in sidebar
    navItems.forEach(nav => nav.classList.remove('active'));
    e.target.classList.add('active');
    
    // Update title
    pageTitle.textContent = e.target.textContent;

    // Switch views
    const targetId = e.target.getAttribute('data-target');
    viewSections.forEach(section => {
      section.hidden = (section.id !== targetId);
      if(section.id === targetId) section.classList.add('active');
    });

    // Close mobile menu on select
    sidebar.classList.remove('open');
  });
});

// Mobile Sidebar toggle
mobileMenuBtn.addEventListener('click', () => sidebar.classList.add('open'));
mobileCloseBtn.addEventListener('click', () => sidebar.classList.remove('open'));

// ---------------------------------------------------------
// DATA RENDERING
// ---------------------------------------------------------
function getBadgeClass(status) {
  const s = status.toLowerCase();
  if (s === 'present' || s === 'active' || s === 'configured') return 'present';
  if (s === 'late') return 'late';
  if (s === 'absent' || s === 'suspended') return 'absent';
  return 'inactive';
}

function renderDashboard() {
  document.getElementById('dash-total-teachers').textContent = MOCK_TEACHERS.length;
  document.getElementById('dash-present').textContent = '2';
  document.getElementById('dash-late').textContent = '1';
  document.getElementById('dash-absent').textContent = '1';

  const tbody = document.getElementById('dash-activity-tbody');
  tbody.innerHTML = MOCK_INSPECTION.slice(0,3).map(record => `
    <tr>
      <td>${new Date(record.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
      <td>${record.id}</td>
      <td>${record.name}</td>
      <td>${record.inst}</td>
      <td><span class="badge ${getBadgeClass(record.status)}">${record.status}</span></td>
    </tr>
  `).join('');
}

function renderTeachers() {
  const tbody = document.getElementById('teachers-tbody');
  tbody.innerHTML = MOCK_TEACHERS.map(t => `
    <tr>
      <td>${t.id}</td>
      <td>${t.name}</td>
      <td>${t.inst}</td>
      <td><span class="badge ${getBadgeClass(t.status)}">${t.status}</span></td>
      <td>
        <button class="link" onclick="openMockDialog('Edit Teacher')">Edit</button>
      </td>
    </tr>
  `).join('');
}

function renderInstitutions() {
  const tbody = document.getElementById('institutions-tbody');
  tbody.innerHTML = MOCK_INSTITUTIONS.map(inst => `
    <tr>
      <td>${inst.name}</td>
      <td>${inst.type}</td>
      <td>${inst.count}</td>
      <td><span class="badge ${getBadgeClass(inst.status)}">${inst.status}</span></td>
      <td>
        <button class="link" onclick="openMockDialog('Edit Institution')">Edit</button>
      </td>
    </tr>
  `).join('');
}

function renderInspection() {
  const tbody = document.getElementById('inspection-tbody');
  tbody.innerHTML = MOCK_INSPECTION.map(record => `
    <tr>
      <td>${new Date(record.time).toLocaleDateString()}</td>
      <td>${record.name} (${record.id})</td>
      <td><span class="badge ${getBadgeClass(record.status)}">${record.status}</span></td>
      <td><span class="badge ${record.gps ? 'present' : 'absent'}">${record.gps ? 'Verified' : 'Failed'}</span></td>
      <td><span class="badge ${record.face ? 'present' : 'absent'}">${record.face ? 'Matched' : 'Failed'}</span></td>
    </tr>
  `).join('');
}

// ---------------------------------------------------------
// MODAL DIALOG LOGIC
// ---------------------------------------------------------
const dialog = document.getElementById('admin-dialog');
const dialogCancel = document.getElementById('dialog-cancel');
const dialogTitle = document.getElementById('dialog-title');
const dialogContent = document.getElementById('dialog-content');

// Exposed to window so inline onclick handlers can reach it
window.openMockDialog = function(title) {
  dialogTitle.textContent = title;
  dialogContent.innerHTML = `<p class="help">This is a mock UI form for <strong>${title}</strong>. Form saving will be implemented alongside backend APIs.</p>`;
  if(typeof dialog.showModal === 'function') dialog.showModal();
  else alert('Dialog API not supported in this browser.');
};

dialogCancel.addEventListener('click', () => dialog.close());
document.getElementById('admin-dialog-form').addEventListener('submit', (e) => {
  e.preventDefault();
  alert('Mock Action Saved.');
  dialog.close();
});

// Form blocks (Settings)
document.getElementById('form-timing').addEventListener('submit', (e) => {
  e.preventDefault();
  alert('Mock: Attendance timings saved locally.');
});
document.getElementById('form-gps').addEventListener('submit', (e) => {
  e.preventDefault();
  alert('Mock: GPS geofence settings saved locally.');
});

// Initialize mock renders
document.addEventListener('DOMContentLoaded', () => {
  renderDashboard();
  renderTeachers();
  renderInstitutions();
  renderInspection();
});