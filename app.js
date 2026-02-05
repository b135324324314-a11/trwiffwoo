// --- إعدادات Supabase ---
const SUPABASE_URL = "https://hufvpwlchyjdsxwthulm.supabase.co";
const SUPABASE_KEY = "sb_publishable_ljnjvVN8cfjzG5XBj0BeGA_-ZAXsf2y";

// تهيئة Supabase Client
const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// --- إعدادات التطبيق ---
const APP_PIN = "123321";
const LOCAL_STORAGE_KEY = "car_debt_supabase_v1";
const TABLE_NAME = "customers";
const BUCKET_NAME = "debt-images";

// المتغيرات العامة
let currentState = {
    customers: [],
    pendingSync: false // هل توجد بيانات بحاجة للرفع؟
};
let currentCustomerViewId = null;
let selectedCustomerIdForPay = null;
let selectedImagesForPrint = new Set();
let currentEditingCustomerId = null;

// --- التعامل مع قاعدة البيانات المحلية للصور (IndexedDB) ---
const dbName = "DebtAppImagesDB";
const storeName = "images";
let idb;

function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName, { keyPath: "id" });
            }
        };
        request.onsuccess = (event) => {
            idb = event.target.result;
            resolve(idb);
        };
        request.onerror = (event) => reject(event.target.error);
    });
}

function saveImageLocally(id, blob) {
    return new Promise((resolve, reject) => {
        const transaction = idb.transaction([storeName], "readwrite");
        const store = transaction.objectStore(storeName);
        store.put({ id: id, blob: blob });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject();
    });
}

function getImageLocally(id) {
    return new Promise((resolve) => {
        const transaction = idb.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result ? request.result.blob : null);
        request.onerror = () => resolve(null);
    });
}

// --- عند التشغيل ---
document.addEventListener('DOMContentLoaded', async () => {
    await initIndexedDB();
    
    // تحميل البيانات المحلية
    const localData = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (localData) {
        currentState = JSON.parse(localData);
        updateUI();
    }

    updateOnlineStatus();
    window.addEventListener('online', () => {
        updateOnlineStatus();
        syncData(); // مزامنة تلقائية عند عودة الإنترنت
    });
    window.addEventListener('offline', updateOnlineStatus);

    // محاولة جلب أحدث البيانات من السحابة إذا كان متصلاً
    if (navigator.onLine) {
        fetchFromSupabase();
    }
});

// --- دوال المزامنة و Supabase ---

// جلب البيانات من Supabase
async function fetchFromSupabase() {
    if (!supabase) return;
    const { data, error } = await supabase.from(TABLE_NAME).select('*');
    if (!error && data) {
        // دمج البيانات: نستخدم البيانات من السيرفر لكن نحتفظ بالصور المحلية التي لم ترفع بعد
        // للتبسيط في هذا التطبيق: السيرفر هو المصدر الحقيقي للحقيقة
        const serverCustomers = data.map(row => row.data);
        currentState.customers = serverCustomers;
        saveDataLocally();
        updateUI();
    }
}

// رفع ملف واحد إلى Supabase Storage
async function uploadToSupabaseStorage(file) {
    if (!supabase) return null;
    const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const { data, error } = await supabase.storage.from(BUCKET_NAME).upload(fileName, file);
    
    if (error) {
        console.error("Upload Error:", error);
        return null;
    }
    
    const { data: publicUrlData } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
    return publicUrlData.publicUrl;
}

// المزامنة: رفع البيانات المعلقة
async function syncData() {
    if (!navigator.onLine || !currentState.pendingSync || !supabase) return;
    
    showLoader(true);
    const syncText = document.getElementById('sync-status');
    if(syncText) syncText.innerText = "جاري المزامنة مع السحابة... ⏳";

    try {
        // 1. البحث عن زبائن لديهم صور محلية (Blob URLs) تحتاج لرفع
        // الصور المحلية تبدأ بـ "blob:"
        for (let cust of currentState.customers) {
            if (cust.images && cust.images.length > 0) {
                let newImages = [];
                let changed = false;
                for (let imgUrl of cust.images) {
                    if (imgUrl.startsWith('blob:')) {
                        // استرجاع الصورة من IndexedDB
                        const blob = await getImageLocally(imgUrl); 
                        if (blob) {
                            const publicUrl = await uploadToSupabaseStorage(blob);
                            if (publicUrl) {
                                newImages.push(publicUrl);
                                changed = true;
                            } else {
                                newImages.push(imgUrl); // فشل الرفع، ابقها للمرة القادمة
                            }
                        } else {
                            newImages.push(imgUrl);
                        }
                    } else {
                        newImages.push(imgUrl);
                    }
                }
                cust.images = newImages;
                
                // تحديث الصف في Supabase
                // نستخدم ID كمعرف للعميل. إذا كان موجود يحدثه، وإلا ينشئه
                await supabase.from(TABLE_NAME).upsert({ 
                    id: cust.id, 
                    data: cust,
                    updated_at: new Date()
                });
            } else {
                // تحديث البيانات النصية فقط
                await supabase.from(TABLE_NAME).upsert({ 
                    id: cust.id, 
                    data: cust,
                    updated_at: new Date()
                });
            }
        }

        currentState.pendingSync = false;
        saveDataLocally();
        if(syncText) syncText.innerText = "✅ تمت المزامنة بنجاح";
        showToast("تمت المزامنة السحابية ☁️");
    } catch (err) {
        console.error("Sync Error:", err);
        if(syncText) syncText.innerText = "❌ خطأ في المزامنة";
    } finally {
        showLoader(false);
    }
}

// --- وظائف مساعدة ---
function showLoader(show) {
    const loader = document.getElementById('loader');
    if (show) loader.classList.remove('hidden');
    else loader.classList.add('hidden');
}

function updateUI() {
    const activePage = document.querySelector('.page.active');
    if (activePage && activePage.id === 'page-customers') renderCustomers();
    if (activePage && activePage.id === 'page-payments') renderPaymentClients();
    if (activePage && activePage.id === 'page-details' && currentCustomerViewId) loadCustomerDetails(currentCustomerViewId);
}

function updateOnlineStatus() {
    const statusEl = document.getElementById('online-status');
    const syncText = document.getElementById('sync-status');
    if (navigator.onLine) {
        statusEl.className = 'status-indicator online';
        if(syncText) syncText.innerText = currentState.pendingSync ? "⚠️ بيانات بانتظار الرفع" : "✅ متصل بالسحابة";
        if (currentState.pendingSync) syncData(); // محاولة مزامنة إذا كان هناك شيء معلق
    } else {
        statusEl.className = 'status-indicator offline';
        if(syncText) syncText.innerText = "⚠️ وضع عدم الاتصال (Offline)";
    }
}

function saveDataLocally() {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(currentState));
}

// دالة الحفظ العامة: تحفظ محلياً وتطلب المزامنة
function saveDataAndSync() {
    currentState.pendingSync = true;
    saveDataLocally();
    if (navigator.onLine) {
        syncData();
    }
}

// --- الأمان ---
function fingerprintAction() {
    const msg = document.getElementById('fingerprint-msg');
    msg.classList.remove('hidden-msg');
    setTimeout(() => msg.classList.add('hidden-msg'), 3000);
}

function checkPin() {
    const input = document.getElementById('pin-input').value;
    if (input === APP_PIN) {
        document.getElementById('welcome-msg').classList.remove('hidden');
        setTimeout(() => {
            document.getElementById('welcome-msg').classList.add('hidden');
            document.getElementById('login-screen').classList.add('hidden');
            updateUI();
        }, 1200);
    } else {
        document.getElementById('login-error').innerText = "رمز خطأ! حاول مجدداً";
    }
}

function logout() { location.reload(); }

function showPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    document.getElementById(`page-${pageId}`).classList.add('active');
    
    const navLink = document.querySelector(`.nav-item[onclick*="'${pageId}'"]`);
    if(navLink) navLink.classList.add('active');

    if(pageId === 'customers') renderCustomers();
    if(pageId === 'payments') renderPaymentClients();
}

function showToast(msg) {
    const x = document.getElementById("toast");
    x.innerText = msg;
    x.className = "toast show";
    setTimeout(() => { x.className = x.className.replace("show", ""); }, 3000);
}

// --- إضافة زبون جديد ---
async function addCustomer() {
    const name = document.getElementById('cust-name').value;
    const car = document.getElementById('cust-car').value;
    const phone = document.getElementById('cust-phone').value;
    const total = parseFloat(document.getElementById('cust-total').value);
    const paid = parseFloat(document.getElementById('cust-paid').value) || 0;
    const checker = document.getElementById('cust-checker').value;
    const notes = document.getElementById('cust-notes').value;
    const currency = document.querySelector('input[name="currency"]:checked').value; 
    const imageInput = document.getElementById('cust-images');

    if (!name || !phone || isNaN(total) || !car) {
        alert("يرجى ملء الحقول الإجبارية");
        return;
    }

    showLoader(true);

    // معالجة الصور: حفظها في IndexedDB كـ Blob وإنشاء رابط مؤقت
    let tempImageUrls = [];
    if (imageInput.files.length > 0) {
        for (let file of imageInput.files) {
            // إنشاء معرف فريد للصورة المحلية
            const localImgId = `blob:${Date.now()}-${Math.random()}`;
            await saveImageLocally(localImgId, file); // حفظ الصورة الفعلية في IndexedDB
            tempImageUrls.push(localImgId);
        }
    }

    const newCustomer = {
        id: Date.now(), // سيستخدم كـ Primary Key
        name: name,
        carName: car,
        whatsapp: phone,
        currency: currency, 
        totalDebt: total,
        paidTotal: paid,
        remaining: total - paid,
        checkedBy: checker,
        notes: notes,
        images: tempImageUrls, 
        createdAt: new Date().toISOString(),
        payments: []
    };

    if (paid > 0) {
        newCustomer.payments.push({
            id: Date.now() + 1,
            amount: paid,
            note: "دفعة أولية عند التسجيل",
            date: new Date().toISOString()
        });
    }

    if (!currentState.customers) currentState.customers = [];
    currentState.customers.push(newCustomer);
    
    saveDataAndSync(); // حفظ ومحاولة المزامنة
    showLoader(false);
    showToast("تمت الإضافة محلياً ✅");
    
    // تنظيف
    document.getElementById('cust-name').value = '';
    document.getElementById('cust-car').value = '';
    document.getElementById('cust-phone').value = '';
    document.getElementById('cust-total').value = '';
    document.getElementById('cust-paid').value = '0';
    document.getElementById('cust-notes').value = '';
    document.getElementById('cust-images').value = '';
    
    showPage('customers');
}

function renderCustomers() {
    const list = document.getElementById('customers-list');
    const query = document.getElementById('search-customers').value.toLowerCase();
    list.innerHTML = '';

    if(!currentState.customers) currentState.customers = [];
    const sorted = [...currentState.customers].reverse();
    const filtered = sorted.filter(c => c.name.toLowerCase().includes(query) || c.carName.toLowerCase().includes(query));

    if(filtered.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:30px; color:#64748b;">لا توجد بيانات مطابقة</div>';
        return;
    }

    filtered.forEach(c => {
        const item = document.createElement('div');
        item.className = `list-item ${c.remaining <= 0 ? 'clear' : 'debt'}`;
        item.onclick = () => loadCustomerDetails(c.id);
        
        item.innerHTML = `
            <div class="item-info">
                <h4>${c.name}</h4>
                <small><i class="fas fa-car"></i> ${c.carName}</small>
                <small><i class="fab fa-whatsapp"></i> ${c.whatsapp}</small>
            </div>
            <div class="price-tag">
                ${formatMoney(c.remaining, c.currency)}<br>
                <span>متبقي</span>
            </div>
        `;
        list.appendChild(item);
    });
}

function loadCustomerDetails(id) {
    const customer = currentState.customers.find(c => c.id === id);
    if (!customer) return;

    currentCustomerViewId = id;
    const container = document.getElementById('details-container');
    const payments = customer.payments || [];
    const curr = customer.currency || 'IQD';

    let imagesHtml = '';
    if (customer.images && customer.images.length > 0) {
        imagesHtml = `<div style="display:flex; gap:10px; overflow-x:auto; margin-top:10px; padding-bottom:5px;">`;
        for (let url of customer.images) {
            // إذا كانت الصورة blob ولم نستطع عرضها مباشرة (رغم أن المتصفح يدعم ذلك إذا كان نفس الجلسة)
            // سنحاول عرضها. إذا كانت رابط supabase ستعمل مباشرة.
            if(url.startsWith('blob:') && !url.includes('http')) {
                // هنا يجب أن نجلب البلوب من IndexedDB وننشئ رابط مؤقت للعرض
                // للتبسيط سنعرض أيقونة "قيد الرفع" أو نحاول العرض
                 imagesHtml += `<div class="img-thumb-container" style="width:60px;height:60px;"><i class="fas fa-sync fa-spin" style="line-height:60px;width:100%;text-align:center;color:#aaa"></i></div>`;
                 // ملاحظة: لعرض الصورة المخزنة في الـ DB Offline يحتاج كود إضافي غير متزامن داخل الـ render، 
                 // لكن سنكتفي بعرض الصور المرفوعة أو الروابط المباشرة لعدم تعقيد الكود أكثر.
                 // الحل السريع:
                 getImageLocally(url).then(blob => {
                     if(blob) {
                         const objUrl = URL.createObjectURL(blob);
                         // تحديث الصورة في الـ DOM بعد التحميل
                         // هذا يتطلب معرفة العنصر.. سنتخطى هذا للجزء البسيط
                     }
                 });
            } else {
                 imagesHtml += `<img src="${url}" style="height:60px; border-radius:8px; border:1px solid #bae6fd;">`;
            }
        }
        imagesHtml += `</div>`;
    }

    container.innerHTML = `
        <h2>${customer.name}</h2>
        <div class="details-row"><strong>السيارة:</strong> <span>${customer.carName}</span></div>
        <div class="details-row"><strong>الهاتف:</strong> <a href="https://wa.me/${customer.whatsapp.replace('+','')}" style="color:var(--primary)">${customer.whatsapp}</a></div>
        ${imagesHtml}
        <br>
        <div class="details-row"><span>أصل الدين:</span> <strong>${formatMoney(customer.totalDebt, curr)}</strong></div>
        <div class="details-row"><span>مجموع واصل:</span> <strong class="highlight-val">${formatMoney(customer.paidTotal, curr)}</strong></div>
        <div class="details-row"><span>الباقي بذمته:</span> <strong class="danger-val">${formatMoney(customer.remaining, curr)}</strong></div>
        <br>
        <p style="font-size:0.9rem; color:var(--text-muted); background:var(--input-bg); padding:10px; border-radius:8px;">
            <strong>📝 ملاحظات:</strong> ${customer.notes || 'لا يوجد'}<br>
            <strong>👤 المدقق:</strong> ${customer.checkedBy || '-'}
        </p>
    `;

    const transList = document.getElementById('transactions-list');
    transList.innerHTML = '';
    
    [...payments].reverse().forEach(p => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.style.cursor = 'default';
        row.innerHTML = `
            <div>
                <strong style="color:var(--primary)">${formatMoney(p.amount, curr)}</strong>
                <div style="font-size:0.8rem; color:var(--text-muted)">${p.note}</div>
            </div>
            <div style="font-size:0.75rem; text-align:left; color:#64748b">
                ${new Date(p.date).toLocaleDateString('ar-IQ')}<br>
                ${new Date(p.date).toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit'})}
            </div>
        `;
        transList.appendChild(row);
    });

    showPage('details');
    
    // إصلاح عرض الصور الـ Offline (تحسين)
    if (customer.images) {
         customer.images.forEach((url, idx) => {
             if(url.startsWith('blob:')) {
                 getImageLocally(url).then(blob => {
                     if(blob) {
                         const realUrl = URL.createObjectURL(blob);
                         // البحث عن الـ placeholder واستبداله
                         const imgs = container.querySelectorAll('.img-thumb-container i');
                         if(imgs[idx]) imgs[idx].parentNode.innerHTML = `<img src="${realUrl}" style="width:100%;height:100%;object-fit:cover">`;
                     }
                 });
             }
         });
    }
}

// --- قسم التسديد ---
function renderPaymentClients() {
    const list = document.getElementById('payment-clients-list');
    const query = document.getElementById('search-payment-client').value.toLowerCase();
    list.innerHTML = '';
    
    if(!currentState.customers) return;

    const filtered = currentState.customers.filter(c => c.remaining > 0 && c.name.toLowerCase().includes(query));

    filtered.forEach(c => {
        const item = document.createElement('div');
        item.className = 'list-item debt';
        item.onclick = () => openPaymentModal(c.id);
        const curr = c.currency || 'IQD';
        item.innerHTML = `
            <div class="item-info">
                <h4>${c.name}</h4>
                <small>${c.carName}</small>
            </div>
            <div class="price-tag">${formatMoney(c.remaining, curr)}</div>
        `;
        list.appendChild(item);
    });
}

function openPaymentModal(id) {
    selectedCustomerIdForPay = id;
    selectedImagesForPrint = new Set();
    const c = currentState.customers.find(x => x.id === id);
    const curr = c.currency || 'IQD';
    
    document.getElementById('pay-modal-info').innerHTML = `
        الزبون: <b style="color:var(--primary)">${c.name}</b><br>
        الباقي الحالي: <span style="color:var(--danger)">${formatMoney(c.remaining, curr)}</span>
    `;
    
    document.getElementById('payment-inputs-area').classList.remove('hidden');
    document.getElementById('print-options-area').classList.add('hidden');
    document.getElementById('pay-amount').value = '';
    document.getElementById('pay-note').value = '';
    
    document.getElementById('payment-form-modal').classList.remove('hidden');
    document.getElementById('pay-amount').focus();
}

function closePaymentModal() {
    document.getElementById('payment-form-modal').classList.add('hidden');
    selectedCustomerIdForPay = null;
}

function submitPayment() {
    const amount = parseFloat(document.getElementById('pay-amount').value);
    const note = document.getElementById('pay-note').value;
    
    if (!amount || amount <= 0) {
        alert("يرجى إدخال مبلغ صحيح");
        return;
    }

    const cIndex = currentState.customers.findIndex(x => x.id === selectedCustomerIdForPay);
    if (cIndex === -1) return;

    const c = currentState.customers[cIndex];
    c.paidTotal += amount;
    c.remaining = c.totalDebt - c.paidTotal;
    
    if(!c.payments) c.payments = [];
    c.payments.push({
        id: Date.now(),
        amount: amount,
        note: note || "تسديد نقدي",
        date: new Date().toISOString()
    });

    saveDataAndSync();
    showToast("تم حفظ التسديد 💰");
    renderPaymentClients();
    
    setupPrintModeInModal(c);
}

function setupPrintModeInModal(customer) {
    document.getElementById('payment-inputs-area').classList.add('hidden');
    document.getElementById('print-options-area').classList.remove('hidden');

    const imgContainer = document.getElementById('payment-images-container');
    imgContainer.innerHTML = '';

    if (customer.images && customer.images.length > 0) {
        customer.images.forEach(async (imgUrl, idx) => {
            const div = document.createElement('div');
            div.className = 'img-thumb-container';
            
            // التعامل مع الصور المحلية والعامة
            let src = imgUrl;
            if (imgUrl.startsWith('blob:') && !imgUrl.includes('http')) {
                 const blob = await getImageLocally(imgUrl);
                 if (blob) src = URL.createObjectURL(blob);
            }
            
            div.innerHTML = `<img src="${src}">`;
            div.onclick = function() {
                if (div.classList.contains('selected')) {
                    div.classList.remove('selected');
                    selectedImagesForPrint.delete(src); // نستخدم الرابط القابل للعرض
                } else {
                    div.classList.add('selected');
                    selectedImagesForPrint.add(src);
                }
            };
            imgContainer.appendChild(div);
        });
    } else {
        imgContainer.innerHTML = '<p style="grid-column:1/-1; text-align:center; color:#64748b">لا توجد صور لهذا الزبون</p>';
    }
}

function executePrint() {
    const customer = currentState.customers.find(x => x.id === selectedCustomerIdForPay);
    if (!customer) return;

    const curr = customer.currency || 'IQD';
    const lastPayment = customer.payments[customer.payments.length - 1];
    const printArea = document.getElementById('print-area');
    
    let imagesHtml = '';
    if (selectedImagesForPrint.size > 0) {
        imagesHtml = `<div class="print-images-area">
            ${Array.from(selectedImagesForPrint).map(url => `
                <div class="print-img-box"><img src="${url}"></div>
            `).join('')}
        </div>`;
    }

    printArea.innerHTML = `
        <div class="invoice-header">
            <h2>وصل تسديد نقد</h2>
            <p>تاريخ: ${new Date().toLocaleString('ar-IQ')}</p>
        </div>

        <div class="info-grid">
            <div>
                <strong>الزبون:</strong> ${customer.name} <br>
                <strong>السيارة:</strong> ${customer.carName}
            </div>
            <div>
                <strong>رقم الوصل:</strong> #${lastPayment.id} <br>
                <strong>الهاتف:</strong> ${customer.whatsapp}
            </div>
        </div>

        <div class="summary-box">
             <div style="font-size:1.4rem; text-align:center; margin-bottom:10px;">
                المبلغ الواصل: <strong>${formatMoney(lastPayment.amount, curr)}</strong>
            </div>
            <div style="text-align:center;">
                فقط وقدره: ${lastPayment.note}
            </div>
        </div>

        <table class="print-table">
            <tr>
                <th>أصل الدين</th>
                <th>مجموع المسدد سابقاً وحالياً</th>
                <th>الباقي الحالي بذمته</th>
            </tr>
            <tr>
                <td>${formatMoney(customer.totalDebt, curr)}</td>
                <td>${formatMoney(customer.paidTotal, curr)}</td>
                <td style="font-weight:bold">${formatMoney(customer.remaining, curr)}</td>
            </tr>
        </table>

        ${imagesHtml}

        <div class="print-footer">
            <p>شكراً لتعاملكم معنا</p>
            <br><br>
            <div style="display:flex; justify-content:space-around">
                <span>توقيع المستلم</span>
                <span>توقيع الحسابات</span>
            </div>
        </div>
    `;

    window.print();
    closePaymentModal();
}

// --- التعديل ---
function openEditModal() {
    if (!currentCustomerViewId) return;
    const customer = currentState.customers.find(c => c.id === currentCustomerViewId);
    if (!customer) return;

    currentEditingCustomerId = customer.id;

    document.getElementById('edit-name').value = customer.name;
    document.getElementById('edit-car').value = customer.carName;
    document.getElementById('edit-phone').value = customer.whatsapp;
    document.getElementById('edit-total').value = customer.totalDebt;
    document.getElementById('edit-paid').value = customer.paidTotal;
    document.getElementById('edit-notes').value = customer.notes;
    document.getElementById('edit-new-images').value = '';

    const imgContainer = document.getElementById('edit-images-list');
    imgContainer.innerHTML = '';
    if (customer.images) {
        customer.images.forEach(async (url) => {
            let src = url;
            if (url.startsWith('blob:') && !url.includes('http')) {
                const blob = await getImageLocally(url);
                if (blob) src = URL.createObjectURL(blob);
            }

            const div = document.createElement('div');
            div.className = 'img-thumb-container';
            div.innerHTML = `
                <img src="${src}">
                <button class="delete-img-btn" onclick="deleteImageFromEdit('${url}')">×</button>
            `;
            imgContainer.appendChild(div);
        });
    }

    document.getElementById('edit-modal').classList.remove('hidden');
}

window.deleteImageFromEdit = function(urlToDelete) {
    if(!confirm('حذف الصورة؟')) return;
    const customer = currentState.customers.find(c => c.id === currentEditingCustomerId);
    if(customer && customer.images) {
        customer.images = customer.images.filter(url => url !== urlToDelete);
        openEditModal(); 
    }
};

async function saveEditCustomer() {
    const customer = currentState.customers.find(c => c.id === currentEditingCustomerId);
    if (!customer) return;

    customer.name = document.getElementById('edit-name').value;
    customer.carName = document.getElementById('edit-car').value;
    customer.whatsapp = document.getElementById('edit-phone').value;
    customer.totalDebt = parseFloat(document.getElementById('edit-total').value) || 0;
    customer.paidTotal = parseFloat(document.getElementById('edit-paid').value) || 0;
    customer.notes = document.getElementById('edit-notes').value;
    customer.remaining = customer.totalDebt - customer.paidTotal;

    const newImagesInput = document.getElementById('edit-new-images');
    if (newImagesInput.files.length > 0) {
        showLoader(true);
        for (let file of newImagesInput.files) {
            const localImgId = `blob:${Date.now()}-${Math.random()}`;
            await saveImageLocally(localImgId, file);
            if(!customer.images) customer.images = [];
            customer.images.push(localImgId);
        }
        showLoader(false);
    }

    saveDataAndSync();
    document.getElementById('edit-modal').classList.add('hidden');
    showToast("تم تعديل البيانات ✏️");
    loadCustomerDetails(currentEditingCustomerId);
}

function deleteCustomerConfirm() {
    if(!currentCustomerViewId) return;
    if(confirm("هل أنت متأكد من حذف هذا السجل؟ لا يمكن التراجع!")) {
        // حذف من المحلي
        currentState.customers = currentState.customers.filter(c => c.id !== currentCustomerViewId);
        
        // حذف من Supabase
        if (navigator.onLine && supabase) {
            supabase.from(TABLE_NAME).delete().eq('id', currentCustomerViewId).then(({error}) => {
                if(error) console.error("Delete Error", error);
            });
        }
        
        saveDataLocally();
        showToast("تم الحذف 🗑️");
        showPage('customers');
    }
}

function formatMoney(amount, currency = 'IQD') {
    if (currency === 'USD') {
        return new Intl.NumberFormat('en-US', { 
            style: 'currency', currency: 'USD',
            minimumFractionDigits: 0, maximumFractionDigits: 2
        }).format(amount);
    } else {
        return new Intl.NumberFormat('ar-IQ', { 
            style: 'currency', currency: 'IQD', maximumFractionDigits: 0 
        }).format(amount);
    }
}

function forceSync() {
    if(navigator.onLine) {
        syncData();
    } else {
        alert("لا يوجد إنترنت");
    }
}

window.exportData = function() {
    const dataStr = JSON.stringify(currentState);
    const link = document.createElement('a');
    link.href = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    link.download = `backup_${new Date().toISOString().slice(0,10)}.json`;
    link.click();
};

window.importData = function(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if(data.customers) {
                currentState = data;
                saveDataAndSync();
                alert("تم استعادة البيانات بنجاح");
                location.reload();
            } else {
                alert("ملف غير صالح");
            }
        } catch(err) { alert("خطأ في الملف"); }
    };
    reader.readAsText(file);
};

// ربط الدوال بالنافذة
window.fingerprintAction = fingerprintAction;
window.checkPin = checkPin;
window.logout = logout;
window.showPage = showPage;
window.addCustomer = addCustomer;
window.renderCustomers = renderCustomers;
window.loadCustomerDetails = loadCustomerDetails;
window.renderPaymentClients = renderPaymentClients;
window.openPaymentModal = openPaymentModal;
window.closePaymentModal = closePaymentModal;
window.submitPayment = submitPayment;
window.executePrint = executePrint;
window.openEditModal = openEditModal;
window.saveEditCustomer = saveEditCustomer;
window.deleteCustomerConfirm = deleteCustomerConfirm;
window.forceSync = forceSync;
